/**
 * Pure wire codec: NDJSON framing, frame validation and OSC 7501 reports.
 * No I/O so both directions stay testable without sockets or timers.
 */

/** Protocol revision both halves speak; a mismatch is refused by the plugin. */
export const PROTOCOL_VERSION = 1;

/** One frame, terminator excluded, measured in UTF-8 bytes (ADR: 64 KiB). */
export const MAX_FRAME = 64 * 1024;

/** Root report `app` value; the plugin's default, restated on every report. */
export const APP_NAME = 'dsh';

/** Decoded caps from the plan; an over-cap value is truncated, never emitted raw. */
const MAX_TITLE = 192;
const MAX_MSG = 2048;

/** A word the plugin may report; anything else is a protocol defect. */
const STATE_WORD = /^[a-z][a-z-]*$/;

export interface WelcomeFrame {
  readonly t: 'welcome';
  readonly proto: number;
  readonly session: string;
  readonly title: string;
  readonly state: string;
  readonly turn: number;
}

export interface OscFrame {
  readonly t: 'osc';
  /** Opaque bytes: the forwarder never inspects or re-encodes OSC payloads. */
  readonly data: string;
}

export interface EchoFrame {
  readonly t: 'echo';
  readonly text: string;
}

export interface SessionItem {
  readonly id: string;
  readonly cwd: string;
  readonly live: boolean;
  readonly bridged: boolean;
}

export interface SessionsFrame {
  readonly t: 'sessions';
  readonly items: readonly SessionItem[];
}

export interface ErrorFrame {
  readonly t: 'error';
  readonly code: string;
  readonly message: string;
}

export interface ByeFrame {
  readonly t: 'bye';
  readonly reason: string;
}

export type ServerFrame = WelcomeFrame | OscFrame | EchoFrame | SessionsFrame | ErrorFrame | ByeFrame;

export type HelloFrame =
  | { readonly t: 'hello'; readonly proto: 1; readonly pid: number; readonly attach: string }
  | { readonly t: 'hello'; readonly proto: 1; readonly pid: number; readonly new: { readonly cwd: string } }
  | { readonly t: 'hello'; readonly proto: 1; readonly pid: number };

/** Everything the forwarder may write, per the ADR's client half. */
export type ClientFrame =
  | HelloFrame
  | { readonly t: 'line'; readonly text: string }
  | { readonly t: 'list'; readonly cwd?: string }
  | { readonly t: 'bye' };

export type Decoded =
  | { readonly ok: true; readonly frames: readonly ServerFrame[]; readonly rest: string }
  | { readonly ok: false; readonly reason: string };

/** The fields of one root record; every present field is restated on each report. */
export interface ReportFields {
  readonly state: string;
  readonly app?: string;
  readonly title?: string;
  readonly msg?: string;
}

/** Reports one root record; a report replaces the record whole, so fields repeat. */
export function encodeReport(fields: ReportFields): string {
  const parts = [`state=${fields.state}`];
  if (fields.app !== undefined) parts.push(`app=${fields.app}`);
  if (fields.title !== undefined) parts.push(`title=${Buffer.from(oneLine(fields.title, MAX_TITLE)).toString('base64')}`);
  if (fields.msg !== undefined) parts.push(`msg=${Buffer.from(oneLine(fields.msg, MAX_MSG)).toString('base64')}`);
  return `\x1b]7501;${parts.join(':')}\x1b\\`;
}

/**
 * Splits `chunk` onto the partial frame in `rest` and validates every complete
 * line. An unterminated frame over the cap or an invalid frame is a hard stop,
 * so a desynchronised stream never reaches the writer.
 */
export function decodeChunk(rest: string, chunk: string): Decoded {
  const frames: ServerFrame[] = [];
  let buffer = rest + chunk;
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end === -1) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.length === 0) continue;
    const frame = parseFrame(line);
    if (frame === undefined) {
      const shown = line.length > 60 ? `${line.slice(0, 60)}…` : line;
      return { ok: false, reason: `invalid frame: ${shown}` };
    }
    frames.push(frame);
  }
  if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME) {
    return { ok: false, reason: `frame exceeds ${String(MAX_FRAME)} bytes` };
  }
  return { ok: true, frames, rest: buffer };
}

function parseFrame(line: string): ServerFrame | undefined {
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  switch (raw['t']) {
    case 'welcome':
      if (raw['proto'] !== PROTOCOL_VERSION) return undefined;
      if (!isWord(raw['session']) || typeof raw['title'] !== 'string') return undefined;
      if (!isStateWord(raw['state']) || !isCount(raw['turn'])) return undefined;
      return {
        t: 'welcome',
        proto: raw['proto'],
        session: raw['session'],
        title: raw['title'],
        state: raw['state'],
        turn: raw['turn'],
      };
    case 'osc':
      return typeof raw['data'] === 'string' ? { t: 'osc', data: raw['data'] } : undefined;
    case 'echo':
      return typeof raw['text'] === 'string' ? { t: 'echo', text: raw['text'] } : undefined;
    case 'sessions':
      return parseSessions(raw['items']);
    case 'error':
      return isWord(raw['code']) && typeof raw['message'] === 'string'
        ? { t: 'error', code: raw['code'], message: raw['message'] }
        : undefined;
    case 'bye':
      return typeof raw['reason'] === 'string' ? { t: 'bye', reason: raw['reason'] } : undefined;
    default:
      return undefined;
  }
}

function parseSessions(items: unknown): SessionsFrame | undefined {
  if (!Array.isArray(items)) return undefined;
  const parsed: SessionItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) return undefined;
    const { id, cwd, live, bridged } = item;
    if (!isWord(id) || typeof cwd !== 'string') return undefined;
    if (typeof live !== 'boolean' || typeof bridged !== 'boolean') return undefined;
    parsed.push({ id, cwd, live, bridged });
  }
  return { t: 'sessions', items: parsed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWord(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStateWord(value: unknown): value is string {
  return typeof value === 'string' && STATE_WORD.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Free text must be one control-free line: an embedded ESC would forge a report. */
function oneLine(text: string, cap: number): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .trim()
    .slice(0, cap);
}


