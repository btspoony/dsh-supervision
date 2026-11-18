/**
 * The browsable attach surface: a scrollable transcript, a multi-line editor
 * and a status line, drawn by pi-tui over the forwarder's stdout.
 *
 * This module only runs when stdin and stdout are both terminals and
 * `--no-tui` is absent; a redirected stdout keeps the append-only line bytes
 * `routeFrame` already produces, because a supervisor parses those bytes.
 */

import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import {
  Box,
  CombinedAutocompleteProvider,
  Editor,
  Markdown,
  ProcessTerminal,
  Spacer,
  TuiAltScreen,
  getKeybindings,
  isKeyRelease,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type AutocompleteItem,
  type Component,
  type EditorTheme,
  type SlashCommand,
  type Terminal,
} from '@earendil-works/pi-tui';
import {
  isProgramState,
  renderAsk,
  stripControls,
  type AskFrame,
  type CatalogCommand,
  type CatalogSkill,
  type MirrorItem,
  type ProgramState,
  type Welcome,
} from 'dsh-supervision-protocol';
import { PLAIN, markdownTheme, themeFor, type Theme, type Token } from './theme.js';

/** Everything the status line knows; every field but `session` updates later. */
export interface Status {
  readonly session?: string;
  readonly state?: ProgramState;
  readonly turn?: number;
}

/**
 * Where the transcript viewport starts, and whether new entries keep it at the
 * bottom. `unseen` counts entries that arrived while scrolled up.
 */
export interface Scroll {
  readonly top: number;
  readonly follow: boolean;
  readonly unseen: number;
}

/** Nothing scrolled yet, so the viewport sits at the newest entry. */
export const FOLLOWING: Scroll = { top: 0, follow: true, unseen: 0 };

/** First line that still fills the viewport, i.e. the bottom position. */
export function maxTop(total: number, height: number): number {
  return Math.max(0, total - Math.max(0, height));
}

/**
 * Moves the viewport by `delta` lines (negative scrolls back) and clamps it.
 * Reaching the bottom resumes following and drops the unseen count.
 */
export function scrollBy(scroll: Scroll, delta: number, total: number, height: number): Scroll {
  const max = maxTop(total, height);
  const from = scroll.follow ? max : scroll.top;
  const top = Math.min(max, Math.max(0, from + delta));
  const follow = top === max;
  return { top, follow, unseen: follow ? 0 : scroll.unseen };
}

/** Home: back to the oldest line, keeping the unseen marker alive. */
export function scrollToTop(scroll: Scroll, total: number, height: number): Scroll {
  return scrollBy(scroll, -total - 1, total, height);
}

/** End: bottom, and following again. */
export function scrollToBottom(scroll: Scroll, total: number, height: number): Scroll {
  return scrollBy(scroll, total + 1, total, height);
}

/**
 * Records one appended entry: while following the viewport stays at the new
 * bottom, otherwise the trailing marker counts what the reader has not seen.
 */
export function afterAppend(scroll: Scroll, added: number, total: number, height: number): Scroll {
  if (!scroll.follow) return { ...scroll, unseen: scroll.unseen + added };
  return { top: maxTop(total, height), follow: true, unseen: 0 };
}

/** The trailing marker text, or nothing while the bottom is in view. */
export function newMarker(scroll: Scroll): string | undefined {
  return scroll.unseen > 0 ? `↓ ${String(scroll.unseen)} new` : undefined;
}

/**
 * Wraps and truncates one already-rendered block to `width` visible columns.
 * pi-tui refuses lines wider than the viewport, and `renderMirror` measures
 * UTF-16 units, so a CJK block needs this second, width-aware pass.
 */
export function fitLines(block: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const line of block.split('\n')) {
    const wrapped = wrapTextWithAnsi(line, w);
    if (wrapped.length === 0) {
      lines.push('');
      continue;
    }
    for (const part of wrapped) lines.push(truncateToWidth(part, w));
  }
  return lines;
}

/**
 * The root state an OSC 7501 record reports, or nothing when it is a child
 * record (it carries an `id`), a clear, or another OSC entirely. These records
 * are the machine surface, so they keep the status live even when the plugin's
 * `echo` config is off.
 */
export function oscStatus(data: string): Status | undefined {
  const head = '\x1b]7501;';
  const tail = '\x1b\\';
  if (!data.startsWith(head) || !data.endsWith(tail)) return undefined;
  let state: string | undefined;
  for (const field of data.slice(head.length, -tail.length).split(':')) {
    const at = field.indexOf('=');
    if (at === -1) continue;
    const key = field.slice(0, at);
    const value = field.slice(at + 1);
    // A child record describes a parked ask, not the session.
    if (key === 'id' && value !== '') return undefined;
    if (key === 'state') state = value;
  }
  return state !== undefined && isProgramState(state) ? { state } : undefined;
}

/**
 * The status the root word seeds. The plugin can only advance the turn through
 * the echo lines its `echo` config writes, so with echo off nothing after this
 * frame carries a count: seeding one would freeze a number on screen.
 * @param frame - the decoded `welcome` frame.
 */
export function welcomeStatus(frame: Welcome): Status {
  return {
    session: frame.session,
    state: frame.state,
    turn: frame.echo === false ? undefined : frame.turn,
  };
}

/** The state an echo line reports, e.g. `[turn 3] working`; anything else is prose. */
export function echoStatus(text: string): Status | undefined {
  const match = /^\[turn (\d+)\] (\w+)$/.exec(text);
  const raw = match?.[2];
  if (match === null || raw === undefined || !isProgramState(raw)) return undefined;
  return { state: raw, turn: Number(match[1]) };
}

/** How long a second Ctrl+C on an empty editor still counts as "again". */
export const CTRL_C_WINDOW_MS = 1500;

/** The dim hint one Ctrl+C on an empty editor shows. */
export const CTRL_C_HINT = 'Ctrl+C again to exit';

/**
 * The forwarder-local exit commands, exact and lowercase: they leave the attach
 * from either surface and are never forwarded. Unlike the host's vocabulary,
 * these belong to the forwarder, so they are also always in the slash menu.
 */
export const LOCAL_EXITS = ['q', 'quit', 'exit', 'bye'] as const;

/**
 * Whether one submitted line is a forwarder-local exit. Anything longer or
 * differently cased is ordinary input for the session.
 * Trailing whitespace is ignored because accepting a menu entry appends a space.
 * @param text - the submitted editor text.
 */
export function isLocalExit(text: string): boolean {
  const line = text.trimEnd();
  return line.startsWith('/') && (LOCAL_EXITS as readonly string[]).includes(line.slice(1));
}

/** What the line sender does with one submitted text. */
export type LineAction = { readonly kind: 'exit' } | { readonly kind: 'send'; readonly text: string };

/**
 * Decides whether a submitted line is forwarder-local or belongs to the session.
 * The exit commands must never reach the socket as a `line` frame.
 * @param text - the submitted editor text.
 */
export function lineAction(text: string): LineAction {
  return isLocalExit(text) ? { kind: 'exit' } : { kind: 'send', text };
}

/** What one Ctrl+C press does, given the editor and the previous press. */
export type CtrlCAction = 'clear' | 'hint' | 'exit';

/**
 * The Ctrl+C convention: with text in the editor it clears that text; on an
 * empty editor the first press shows a hint and a second one inside
 * {@link CTRL_C_WINDOW_MS} leaves. It never touches the running turn.
 * @param input - editor state, now, and the previous hint's timestamp.
 */
export function ctrlCAction(input: {
  readonly editorEmpty: boolean;
  readonly now: number;
  readonly last: number | undefined;
}): CtrlCAction {
  if (!input.editorEmpty) return 'clear';
  if (input.last !== undefined && input.now - input.last <= CTRL_C_WINDOW_MS) return 'exit';
  return 'hint';
}

/**
 * Esc belongs to an open completion menu, not to the turn: while the menu is up
 * the Editor must receive the key so it can close it, and only then does Esc
 * mean "cancel the running turn".
 * @param context - whether the editor's completion menu is open.
 */
export function escAction(context: { readonly menuOpen: boolean }): 'pass' | 'cancel' {
  return context.menuOpen ? 'pass' : 'cancel';
}

/** What one submitted line does: end the bridge locally, or send the text. */
export interface LineSink {
  readonly send: (text: string) => void;
  readonly exit: () => void;
}

/**
 * Routes one submitted line. A forwarder-local exit command ends the bridge and
 * is never written to the socket as a `line` frame.
 * @param text - the submitted editor text.
 * @param sink - the socket writer and the local exit.
 */
export function routeLine(text: string, sink: LineSink): void {
  const action = lineAction(text);
  if (action.kind === 'exit') {
    sink.exit();
    return;
  }
  sink.send(action.text);
}

/** The one open ask that can absorb a bare answer, when there is exactly one. */
function bareAnswerAsk(open: ReadonlyMap<string, AskFrame>): { readonly id: string } | undefined {
  if (open.size !== 1) return undefined
  const [ask] = open.values()
  if (ask === undefined || 'closed' in ask) return undefined
  return ask
}

/**
 * Rewrites one submitted line for the ask surface. A typed `/answer` is already
 * the grammar and passes verbatim; while exactly one ask is open, a bare `-`,
 * `2` or `1,3` is the operator answering it, so the ask id is added. A
 * multi-question ask then answers with the plugin's own "missing answer" line
 * instead of silently steering the agent. Everything else stays an ordinary
 * steer: an open question must not swallow one.
 * @param text - the editor's text.
 * @param open - the asks the surface has not seen closed.
 * @returns the line to send to the plugin.
 */
export function answerLine(text: string, open: ReadonlyMap<string, AskFrame>): string {
  if (/^\/answer\b/.test(text.trim())) return text
  const ask = bareAnswerAsk(open)
  if (ask === undefined) return text
  const value = text.trim()
  return /^(-|[0-9]+(,[0-9]+)*)$/.test(value) ? `/answer ${ask.id} ${value}` : text
}

/** Side effects the surface's key handling needs; tests pass fakes. */
export interface KeyEffects {
  readonly sendLine: (text: string) => void;
  readonly exit: () => void;
  readonly clearEditor: () => void;
  readonly clearHint: () => void;
  readonly showHint: () => void;
  /** Applies a scroll action to the transcript; returns whether it moved. */
  readonly scroll: (action: KeyAction) => boolean;
}

/** What the key handler remembers between keystrokes. */
export interface KeyMemory {
  readonly lastCtrlC: number | undefined;
  /** Set once an exit was dispatched, so no second trigger can exit twice. */
  readonly exited: boolean;
}

/** The result of one key: the new memory and whether the surface consumed it. */
export interface KeyOutcome {
  readonly memory: KeyMemory;
  readonly consumed: boolean;
}

/**
 * Applies one key action to the surface. Pure in its arguments — the caller
 * supplies the effects — so the Ctrl+C/Esc conventions are testable without a
 * terminal.
 * @param action - the decoded key action.
 * @param memory - the previous keystroke's state.
 * @param context - editor state and the current time.
 * @param effects - what the surface can do.
 */
export function surfaceKey(
  action: KeyAction,
  memory: KeyMemory,
  context: { readonly editorEmpty: boolean; readonly menuOpen: boolean; readonly now: number },
  effects: KeyEffects,
): KeyOutcome {
  // Any key other than Ctrl+C disarms the double-press window: Ctrl+C → Esc →
  // Ctrl+C must not exit, because Esc already dismissed the prompt.
  const idle: KeyMemory = { lastCtrlC: undefined, exited: memory.exited };
  if (action.kind === 'escape') {
    if (escAction({ menuOpen: context.menuOpen }) === 'pass') return { memory: idle, consumed: false };
    effects.sendLine('/cancel');
    return { memory: idle, consumed: true };
  }
  if (action.kind === 'ctrl-c') {
    const next = ctrlCAction({ editorEmpty: context.editorEmpty, now: context.now, last: memory.lastCtrlC });
    if (next === 'clear') {
      effects.clearEditor();
      effects.clearHint();
      return { memory: { lastCtrlC: undefined, exited: memory.exited }, consumed: true };
    }
    if (next === 'hint') {
      effects.showHint();
      return { memory: { lastCtrlC: context.now, exited: memory.exited }, consumed: true };
    }
    if (!memory.exited) effects.exit();
    return { memory: { lastCtrlC: undefined, exited: true }, consumed: true };
  }
  if (action.kind === 'exit') {
    if (!memory.exited) effects.exit();
    return { memory: { lastCtrlC: undefined, exited: true }, consumed: true };
  }
  effects.scroll(action);
  return { memory: idle, consumed: true };
}

/** One attach surface: `tui` owns stdout, `line` is today's append-only path. */
export function chooseSurface(input: {
  readonly stdinTTY: boolean;
  readonly stdoutTTY: boolean;
  readonly noTui: boolean;
}): 'tui' | 'line' {
  return input.stdinTTY && input.stdoutTTY && !input.noTui ? 'tui' : 'line';
}

/** The session's slash vocabulary, as the plugin sends it after `welcome`. */
export type Catalog = { readonly skills: readonly CatalogSkill[]; readonly commands: readonly CatalogCommand[] };

/** An empty catalog: what a host with neither service advertises. */
export const NO_CATALOG: Catalog = { skills: [], commands: [] };

/**
 * The catalog an inbound frame carries, or nothing for every other frame.
 * @param frame - any decoded frame; the tag is enough because the codec already
 *   proved the shape before the frame reached this surface.
 */
export function catalogOf(frame: unknown): Catalog | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined;
  const record = frame as Record<string, unknown>;
  if (record['t'] !== 'catalog') return undefined;
  // The codec proved the sections before the frame reached the surface.
  return { skills: record['skills'] as CatalogSkill[], commands: record['commands'] as CatalogCommand[] };
}

/**
 * The slash menu for one catalog: a `skill:<name>` entry per skill (typed as
 * `/skill:`, which the provider fuzzy-matches against the bare names), then the
 * forwarder's own exit commands. A wire `commands` row is deliberately not
 * rendered: the bridge cannot execute one, so listing it would advertise a slash
 * command that does nothing. Argument completions filter the skills again, so a
 * half-typed name narrows instead of guessing.
 * @param catalog - the host's advertised vocabulary; an empty one still offers
 *   the forwarder-local exits.
 */
export function autocompleteCatalog(catalog: Catalog): SlashCommand[] {
  // A host string goes straight into the menu, which the terminal renders
  // verbatim: a control byte there is an escape sequence or a split into the
  // editor's inserted text. Unsafe rows are dropped, never silently rewritten.
  const safeSkills = catalog.skills.filter(
    (skill) => SKILL_ROW_NAME.test(skill.name) && isPlainText(skill.name) && isPlainText(skill.description),
  );
  const items = (prefix: string): AutocompleteItem[] =>
    safeSkills
      .filter((skill) => skill.name.startsWith(prefix))
      // The argument is a skill name, so the completion inserts the name only.
      .map((skill) => ({ value: skill.name, label: skill.name, description: skill.description }));
  const skills: SlashCommand[] = safeSkills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    getArgumentCompletions: (prefix: string) => items(prefix),
  }));
  const local: SlashCommand[] = LOCAL_EXITS.map((name) => ({ name, description: 'leave dsh-sup (local)' }));
  return [...skills, ...local];
}

/**
 * The `fd` binary pi-tui's file completion spawns, when it is installed. The
 * library needs an explicit path; without one, `@file` completion is simply off.
 * @returns the binary path, or undefined.
 */
export function fdBinary(): string | undefined {
  const dirs = (process.env['PATH'] ?? '').split(':').filter((dir) => dir !== '');
  for (const name of ['fd', 'fdfind']) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not in this directory; keep looking.
      }
    }
  }
  return undefined;
}

/**
 * The editor's autocomplete provider for one catalog.
 * @param catalog - the host's advertised vocabulary.
 * @param basePath - the session's directory; `@file` completion resolves here.
 */
export function providerFor(catalog: Catalog, basePath: string): CombinedAutocompleteProvider {
  return new CombinedAutocompleteProvider(autocompleteCatalog(catalog), basePath, fdBinary() ?? null);
}

// The plugin's skill-name shape: a catalog row outside it could never be typed
// as a slash command, so the menu would advertise a dead row.
const SKILL_ROW_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** True when a catalog field carries no control bytes a terminal would obey. */
function isPlainText(value: string): boolean {
  return stripControls(value) === value;
}

/** What one input sequence means to the surface, if anything. */
export type KeyAction =
  | { readonly kind: 'escape' }
  | { readonly kind: 'ctrl-c' }
  | { readonly kind: 'exit' }
  | { readonly kind: 'page'; readonly delta: number }
  | { readonly kind: 'line'; readonly delta: number }
  | { readonly kind: 'top' }
  | { readonly kind: 'bottom' };

/**
 * Maps one input sequence to a surface action.
 * @param data - the raw bytes one terminal input produced.
 * @param editorEmpty - with text in the editor the arrows, Home and End move
 *   the cursor instead, so they are left to the editor.
 */
export function keyAction(data: string, editorEmpty: boolean): KeyAction | undefined {
  // A Kitty terminal reports press, repeat and release for the same key, and
  // `matchesKey` cannot tell them apart. Acting on a release would scroll a
  // second time on PageUp/PageDown and send a second `/cancel` on Ctrl+C.
  if (isKeyRelease(data)) return undefined;
  // Ctrl+C is context-sensitive and handled by the surface (clear, hint, exit);
  // Esc cancels the running turn, and Ctrl+D leaves. All are editor bindings by
  // default, so they land here first.
  if (matchesKey(data, 'ctrl+c')) return { kind: 'ctrl-c' };
  if (matchesKey(data, 'ctrl+d')) return { kind: 'exit' };
  if (matchesKey(data, 'escape')) return { kind: 'escape' };
  if (matchesKey(data, 'pageUp')) return { kind: 'page', delta: -1 };
  if (matchesKey(data, 'pageDown')) return { kind: 'page', delta: 1 };
  if (!editorEmpty) return undefined;
  if (matchesKey(data, 'up')) return { kind: 'line', delta: -1 };
  if (matchesKey(data, 'down')) return { kind: 'line', delta: 1 };
  if (matchesKey(data, 'home')) return { kind: 'top' };
  if (matchesKey(data, 'end')) return { kind: 'bottom' };
  return undefined;
}

/**
 * The editor frame in one theme: the accent border marks where typing goes, so
 * input reads as a different region from the transcript above it.
 * @param theme - the surface's theme.
 */
export function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text: string): string => theme.fg('accent', text),
    selectList: {
      selectedPrefix: (text: string): string => theme.fg('accent', text),
      selectedText: (text: string): string => theme.bold(text),
      description: (text: string): string => theme.dim(text),
      scrollInfo: (text: string): string => theme.dim(text),
      noMatch: (text: string): string => theme.dim(text),
    },
  };
}

/** The plain editor frame, for callers that build a shell without a terminal. */
export const THEME: EditorTheme = editorTheme(PLAIN);

/** The colour a state segment carries inside the bar. */
function stateToken(state: ProgramState): Token {
  switch (state) {
    case 'working':
      return 'accent';
    case 'done':
      return 'success';
    case 'blocked':
      return 'warning';
    case 'error':
      return 'error';
    case 'idle':
      return 'muted';
  }
}

/** Session, state and turn, on one reverse-video bar above the editor. */
export class StatusLine {
  private status: Status = {};
  private hint: string | undefined;
  private readonly theme: Theme;

  constructor(theme: Theme = PLAIN) {
    this.theme = theme;
  }

  set(next: Status): void {
    this.status = { ...this.status, ...next };
  }

  /** Shows a transient hint in the bar; `undefined` clears it. */
  setHint(hint: string | undefined): void {
    this.hint = hint;
  }

  /** Whether a transient hint is currently shown. */
  hasHint(): boolean {
    return this.hint !== undefined;
  }

  render(width: number): string {
    const w = Math.max(1, Math.floor(width));
    const parts = [this.status.session ?? 'dsh-sup'];
    if (this.status.state !== undefined) parts.push(this.theme.fg(stateToken(this.status.state), this.status.state));
    if (this.status.turn !== undefined) parts.push(`turn ${String(this.status.turn)}`);
    if (this.hint !== undefined) parts.push(this.theme.dim(this.hint));
    const text = parts.join(' · ');
    // The bar owns the whole row: pad first, then invert across the width.
    const padded = text + ' '.repeat(Math.max(0, w - visibleWidth(text)));
    return this.theme.color ? clipStyled(this.theme.bar(padded), w) : truncatePlain(padded, w);
  }
}

/**
 * The transcript viewport: mirror items and echo lines, newest at the bottom.
 * `height` is set by the shell each frame, because the editor's own height
 * decides how many rows are left.
 */
export class TranscriptView implements Component {
  private readonly entries: (MirrorItem | string)[] = [];
  /** Every entry's wrapped lines, flattened: a slice per frame, no re-wrap. */
  private flat: string[] = [];
  private scrollState: Scroll = FOLLOWING;
  /** Viewport rows the shell grants this frame. */
  height = 0;
  /** Width the flattened lines are wrapped at; a different render rewraps all. */
  private width: number;
  private readonly wrapEntry: (entry: MirrorItem | string, width: number) => string[];
  /** The theme the chrome (the follow marker) draws with. */
  private readonly theme: Theme;

  /**
   * @param options - entry renderer injection (for call-counting tests), the
   *   wrap width before the first render, and the theme the entries draw with.
   */
  constructor(options: TranscriptOptions = {}) {
    const theme = options.theme ?? PLAIN;
    this.theme = theme;
    this.width = Math.max(1, Math.floor(options.width ?? 80));
    this.wrapEntry = options.wrapEntry ?? ((entry, width) => renderEntry(entry, width, theme));
  }

  push(entry: MirrorItem | string): void {
    const block = this.block(this.entries.length, entry);
    this.entries.push(entry);
    // Only the new entry is wrapped; the history stays as the last frame left it.
    append(this.flat, block);
    this.scrollState = afterAppend(this.scrollState, 1, this.flat.length, this.height);
  }

  page(delta: number): boolean {
    return this.commit(scrollBy(this.scrollState, delta * Math.max(1, this.height - 1), this.flat.length, this.height));
  }

  line(delta: number): boolean {
    return this.commit(scrollBy(this.scrollState, delta, this.flat.length, this.height));
  }

  toTop(): boolean {
    return this.commit(scrollToTop(this.scrollState, this.flat.length, this.height));
  }

  toBottom(): boolean {
    return this.commit(scrollToBottom(this.scrollState, this.flat.length, this.height));
  }

  /** Nothing here is theme-dependent, so a theme change invalidates nothing. */
  invalidate(): void {}

  render(width: number): string[] {
    const w = Math.max(1, Math.floor(width));
    if (w !== this.width) this.rewrap(w);
    if (this.height <= 0) return [];
    // A resize can leave the stored offset past the new bottom; clamping through
    // the same arithmetic also clears the marker once the bottom is in view.
    this.scrollState = scrollBy(this.scrollState, 0, this.flat.length, this.height);
    const max = maxTop(this.flat.length, this.height);
    const top = this.scrollState.follow ? max : Math.min(this.scrollState.top, max);
    const marker = newMarker(this.scrollState);
    // The marker takes the last row, so one fewer line of transcript shows.
    const rows = marker === undefined ? this.height : this.height - 1;
    const visible = this.flat.slice(top, top + rows);
    while (visible.length < rows) visible.unshift('');
    if (marker !== undefined) visible.push(this.theme.color ? clipStyled(marker, w) : truncatePlain(marker, w));
    return visible;
  }

  private commit(next: Scroll): boolean {
    const changed =
      next.top !== this.scrollState.top || next.follow !== this.scrollState.follow || next.unseen !== this.scrollState.unseen;
    this.scrollState = next;
    return changed;
  }

  /** The one full pass: only a width change needs every entry wrapped again. */
  private rewrap(width: number): void {
    this.width = width;
    this.flat = [];
    for (const [index, entry] of this.entries.entries()) append(this.flat, this.block(index, entry));
  }

  /**
   * A block entry is separated from what precedes it, so a reply never starts
   * flush against the previous one; echo lines stay dense.
   */
  private block(index: number, entry: MirrorItem | string): string[] {
    const lines = this.wrapEntry(entry, this.width);
    if (index === 0 || typeof entry === 'string' || lines.length === 0) return lines;
    return [...SPACER.render(this.width), ...lines];
  }
}

/** A blank row between block entries; one shared instance is enough. */
const SPACER = new Spacer(1);

/** Prefixes a child's first line with a mark, keeping the child inside `width`. */
class Gutter implements Component {
  private readonly child: Component;
  private readonly mark: string;

  constructor(child: Component, mark: string) {
    this.child = child;
    this.mark = mark;
  }

  render(width: number): string[] {
    const w = Math.max(1, Math.floor(width));
    const markWidth = visibleWidth(this.mark);
    // Below the mark's own width there is no room for a gutter; the text wins.
    if (markWidth === 0 || markWidth >= w) return this.child.render(w);
    const mark = this.mark;
    const blank = ' '.repeat(markWidth);
    const inner = this.child.render(w - markWidth);
    if (inner.length === 0) return [mark];
    return inner.map((line, index) => `${index === 0 ? mark : blank}${line}`);
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

/**
 * The user's own line: a tinted block with a gutter, so the thing a person
 * typed never reads like model output.
 *
 * The text renders as Markdown on purpose (issue I-000025, accepted): the
 * transcript is Markdown on both surfaces, the GUI renders operator input the
 * same way, and this block is fed by the same `mirror` frame the GUI reads.
 * Rendering it verbatim would make the terminal the only view that disagrees
 * about input the person just wrote and can see.
 */
function userEntry(text: string, width: number, theme: Theme): string[] {
  const bg = (line: string): string => theme.bg('userBg', line);
  const body = new Markdown(stripControls(text, '\n\t'), 0, 0, markdownTheme(theme), {
    color: (line: string): string => theme.fg('userFg', line),
    bgColor: bg,
  });
  // Padding is a luxury the narrowest terminals cannot afford: one column of
  // padding on both sides of a 1-column viewport would leave no text at all.
  const box = new Box(width >= 3 ? 1 : 0, 0, bg);
  box.addChild(new Gutter(body, theme.fg('accent', '❯ ')));
  return box.render(width);
}

/** Thousands separated, so a large step reads at a glance. */
function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** The usage footer's text, shared by both rendering paths. */
function usageText(usage: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
}): string {
  const cache = usage.cacheReadTokens;
  return `⟦↑${count(usage.inputTokens)} ↓${count(usage.outputTokens)}${cache === undefined ? '' : ` R${count(cache)}`}⟧`;
}

/** Right-aligns one plain line; a line wider than the row is left alone. */
function rightAlign(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visibleWidth(text))) + text;
}

/** The token usage footer: dim, right-aligned, the same content as before. */
function usageLine(
  usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens?: number },
  width: number,
  theme: Theme,
): string {
  return theme.dim(rightAlign(usageText(usage), width));
}

/** Assistant prose: dim reasoning, markdown body, dim usage footer. */
function assistantEntry(item: Extract<MirrorItem, { k: 'assistant' }>, width: number, theme: Theme): string[] {
  const lines: string[] = [];
  const reasoning = stripControls(item.reasoning ?? '', '\n\t').split('\n')[0]?.trim() ?? '';
  if (reasoning !== '') lines.push(...fitLines(theme.dim(`· ${reasoning}`), width));
  const text = stripControls(item.text ?? '', '\n\t');
  if (text.trim() !== '') lines.push(...new Markdown(text, 0, 0, markdownTheme(theme)).render(width));
  // Its own line: appending to a full-width body line would truncate the marker.
  if (item.interrupted === true) lines.push(theme.dim('(interrupted)'));
  if (item.usage !== undefined) lines.push(usageLine(item.usage, width, theme));
  return lines;
}

/** Argument keys worth one status line, in the order a reader wants them. */
const SUMMARY_KEYS = ['description', 'command', 'path', 'query', 'pattern'] as const;

/** The first useful argument a tool call carries, or the head of the raw args. */
function summarize(args: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of SUMMARY_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return value.split('\n')[0]?.trim() ?? '';
    }
  }
  return args.split('\n')[0]?.trim() ?? '';
}

/** The pieces of one tool call, shared by both rendering paths. */
interface ToolParts {
  readonly glyph: string;
  readonly token: Token;
  readonly bg: Token;
  readonly name: string;
  readonly summary: string;
  readonly meta: string;
  readonly detail: string;
}

function toolParts(item: Extract<MirrorItem, { k: 'tool' }>): ToolParts {
  const look =
    item.state === 'start'
      ? { glyph: '⏳', token: 'warning' as const, bg: 'toolBgPending' as const }
      : item.state === 'ok'
        ? { glyph: '✔', token: 'success' as const, bg: 'toolBgOk' as const }
        : { glyph: '✘', token: 'error' as const, bg: 'toolBgError' as const };
  return {
    ...look,
    name: stripControls(item.name),
    summary: summarize(stripControls(item.args, '\n\t')),
    meta: item.state !== 'start' && item.ms !== undefined ? ` ⟦${String(item.ms)}ms⟧` : '',
    detail: stripControls(item.detail ?? '', '\n\t').split('\n')[0]?.trim() ?? '',
  };
}

/** A tool call: a coloured status band, then the dim detail line. */
function toolEntry(item: Extract<MirrorItem, { k: 'tool' }>, width: number, theme: Theme): string[] {
  const parts = toolParts(item);
  const head = `${theme.fg(parts.token, parts.glyph)} ${theme.bold(parts.name)}${parts.summary === '' ? '' : theme.dim(`: ${parts.summary}`)}${parts.meta === '' ? '' : theme.dim(parts.meta)}`;
  const headWidth = visibleWidth(head);
  const fitted = headWidth > width ? sliceByColumn(head, 0, width, true) : head;
  const lines = [theme.bg(parts.bg, fitted + ' '.repeat(Math.max(0, width - Math.min(headWidth, width))))];
  if (parts.detail !== '') lines.push(...fitLines(theme.dim(`  └─ ${parts.detail}`), width));
  return lines;
}

/** An echo or other system line: dim, and small enough to stay dense. */
function systemEntry(text: string, width: number, theme: Theme): string[] {
  return fitLines(text, width).map((line) => theme.dim(line));
}

/**
 * Wraps plain text to `width` columns. `wrapTextWithAnsi` only preserves escape
 * sequences, so plain input comes back plain — which the ANSI-aware truncation
 * helper below does not: its truncating branch appends a reset.
 */
function wrapPlain(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const source of text.split('\n')) {
    const wrapped = wrapTextWithAnsi(source, w);
    if (wrapped.length === 0) lines.push('');
    else lines.push(...wrapped);
  }
  return lines;
}

/**
 * Fits a styled line to `width` by slicing visible columns. `truncateToWidth`
 * replaces an overflowing line with an ellipsis, which loses the content; a
 * slice keeps it. A row that still carries SGR at the cut gets exactly one
 * reset, so the style cannot bleed into the padding of its own row; a row with
 * no SGR gets none, because there is nothing to close. Every rendered entry
 * already fits the viewport, so this is the last-resort guard.
 */
export function clipStyled(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  const clipped = sliceByColumn(line, 0, width, true);
  // The slice keeps whatever SGR was open at the cut, so a reset is needed only
  // when it kept one; a plain row would otherwise gain an escape it never had.
  return clipped.includes('\x1b') ? `${clipped}\x1b[0m` : clipped;
}

/** Truncates to `width` visible columns by code point; adds no escape sequence. */
function truncatePlain(line: string, width: number): string {
  const w = Math.max(1, Math.floor(width));
  if (visibleWidth(line) <= w) return line;
  let out = '';
  for (const char of line) {
    if (visibleWidth(out + char) > w) break;
    out += char;
  }
  return out;
}

/**
 * The plain-theme renderer: same information as the coloured blocks, no SGR and
 * no OSC. It deliberately avoids `Box`, `Markdown` and `truncateToWidth`, each
 * of which can emit styling even when every theme function is an identity.
 */
function plainEntry(entry: MirrorItem | string, width: number): string[] {
  if (typeof entry === 'string') return wrapPlain(entry, width);
  switch (entry.k) {
    case 'user': {
      const mark = '❯ ';
      const markWidth = Math.min(visibleWidth(mark), Math.max(0, width - 1));
      const body = wrapPlain(stripControls(entry.text, '\n\t'), Math.max(1, width - markWidth));
      if (markWidth === 0) return body;
      const head = truncatePlain(mark, markWidth);
      const blank = ' '.repeat(markWidth);
      return body.map((line, index) => `${index === 0 ? head : blank}${line}`);
    }
    case 'assistant': {
      const lines: string[] = [];
      const reasoning = stripControls(entry.reasoning ?? '', '\n\t').split('\n')[0]?.trim() ?? '';
      if (reasoning !== '') lines.push(...wrapPlain(`· ${reasoning}`, width));
      const text = stripControls(entry.text ?? '', '\n\t');
      if (text.trim() !== '') lines.push(...wrapPlain(text, width));
      if (entry.interrupted === true) lines.push('(interrupted)');
      if (entry.usage !== undefined) lines.push(rightAlign(usageText(entry.usage), width));
      return lines;
    }
    case 'tool': {
      const parts = toolParts(entry);
      const head = `${parts.glyph} ${parts.name}${parts.summary === '' ? '' : `: ${parts.summary}`}${parts.meta}`;
      const lines = wrapPlain(head, width);
      if (parts.detail !== '') lines.push(...wrapPlain(`  └─ ${parts.detail}`, width));
      return lines;
    }
  }
}

/**
 * One entry's lines at a width, fully styled: user block, assistant markdown,
 * tool band or dim system line.
 * @param entry - a mirror item, or an echo line (a string).
 * @param width - the viewport width; every line is truncated to it.
 * @param theme - the surface theme; plain by default, so output stays byte-clean.
 */
export function renderEntry(entry: MirrorItem | string, width: number, theme: Theme = PLAIN): string[] {
  const w = Math.max(1, Math.floor(width));
  // The plain path must stay byte-clean: pi-tui's truncation appends a reset and
  // its Markdown renders links through OSC 8, so neither is used without colour.
  if (!theme.color) return plainEntry(entry, w).map((line) => truncatePlain(line, w));
  const lines =
    typeof entry === 'string'
      ? systemEntry(entry, w, theme)
      : entry.k === 'user'
        ? userEntry(entry.text, w, theme)
        : entry.k === 'assistant'
          ? assistantEntry(entry, w, theme)
          : toolEntry(entry, w, theme);
  return lines.map((line) => clipStyled(line, w));
}

/** Entry renderer injection for tests plus the drawing options. */
export interface TranscriptOptions {
  /** Width entries wrap at until a render names the real one. */
  readonly width?: number;
  /** The theme entries draw with; plain when omitted. */
  readonly theme?: Theme;
  /** Replaces the themed renderer, e.g. to count calls without a terminal. */
  readonly wrapEntry?: (entry: MirrorItem | string, width: number) => string[];
}

/** Appends in place; a spread would give a huge block one call frame per line. */
function append(into: string[], lines: readonly string[]): void {
  for (const line of lines) into.push(line);
}

/** Transcript, editor and status stacked into exactly the terminal's rows. */
export class Shell implements Component {
  private readonly terminal: Terminal;
  private readonly transcript: TranscriptView;
  private readonly editor: Editor;
  private readonly status: StatusLine;
  private readonly fallbackWidth: number;

  constructor(
    terminal: Terminal,
    transcript: TranscriptView,
    editor: Editor,
    status: StatusLine,
    fallbackWidth: number,
  ) {
    this.terminal = terminal;
    this.transcript = transcript;
    this.editor = editor;
    this.status = status;
    this.fallbackWidth = fallbackWidth;
  }

  render(width: number): string[] {
    // A narrow terminal must render narrow: widening here would put lines wider
    // than the viewport on screen. Every component truncates to what it gets.
    const w = Math.max(1, Math.floor(width) || this.fallbackWidth || 80);
    const editorLines = this.editor.render(w);
    const rows = Math.max(3, this.terminal.rows || 24);
    this.transcript.height = Math.max(0, rows - editorLines.length - 1);
    return [...this.transcript.render(w), ...editorLines, this.status.render(w)];
  }

  invalidate(): void {
    this.transcript.invalidate();
    this.editor.invalidate();
  }
}

/**
 * Registers the surface's synchronous restore on the exit paths the CLI does
 * not own. Without it a signal or a throw leaves the tty in the alternate
 * screen, raw mode, cursor hidden and bracketed paste on. Call it only once the
 * surface owns the tty. `stop` is expected to be idempotent.
 * @param stop - the surface's own restore, already guarded against a dead screen.
 */
export function restoreOnExit(stop: () => void): void {
  const restore = (): void => {
    try {
      stop();
    } catch {
      // A screen that is already gone must not block the exit itself.
    }
  };
  process.once('exit', restore);
  // SIGTERM and SIGHUP terminate by default without running `exit`, so each
  // restores first and then keeps its own status.
  process.once('SIGTERM', () => {
    restore();
    process.exit(143);
  });
  process.once('SIGHUP', () => {
    restore();
    process.exit(129);
  });
  process.once('uncaughtException', (error: Error) => {
    restore();
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
  // An external `kill -INT` never becomes a byte, and Node's default SIGINT
  // path runs no JavaScript cleanup. Restore, then re-raise the same signal so
  // the process still dies with the default status (130). In-TUI Ctrl+C is a
  // 0x03 byte handled by the Editor and never reaches this handler.
  process.once('SIGINT', () => {
    restore();
    process.kill(process.pid, 'SIGINT');
  });
}

/** The running surface: feed it frames, update the status, stop on exit. */
export interface Surface {
  /** A mirror item, or an echo line (a string) from the plugin. */
  push(entry: MirrorItem | string): void;
  /** An agent question card, or its close; the surface answers it by id. */
  setAsk(frame: AskFrame): void;
  setStatus(status: Status): void;
  /** Replaces the slash menu; the plugin re-sends this after a session switch. */
  setCatalog(catalog: Catalog): void;
  stop(): void;
}

export interface StartTuiOptions {
  readonly title: string;
  /** One submitted line (or `/cancel`), exactly as line mode sends it. */
  readonly sendLine: (text: string) => void;
  /** Called on Ctrl+D, which ends the bridge rather than only the surface. */
  readonly onExit: () => void;
  /** Render width before the terminal reports its columns. */
  readonly width?: number;
  /** Directory `@file` completion resolves against: the session's cwd. */
  readonly basePath?: string;
}

/**
 * Starts the full-screen surface on stdin/stdout.
 * @param options - title, the line sender and the Ctrl+D exit hook.
 * @returns the sink to push frames into; `stop()` restores the terminal.
 */
export function startTui(options: StartTuiOptions): Surface {
  const terminal = new ProcessTerminal();
  // Full-screen (alternate screen): the transcript viewport replaces terminal
  // scrollback while attached. Mouse capture stays off — the plan has no mouse
  // support, and leaving it on would steal the terminal's own selection.
  const tui = new TuiAltScreen(terminal, undefined, undefined, { mouse: false });
  const theme = themeFor();
  const transcript = new TranscriptView({ theme });
  const status = new StatusLine(theme);
  const editor = new Editor(tui, editorTheme(theme));
  const shell = new Shell(terminal, transcript, editor, status, options.width ?? 80);
  const basePath = options.basePath ?? process.cwd();

  /** The slash menu for one catalog; rebuilt whenever the host sends a new one. */
  const useCatalog = (catalog: Catalog): void => {
    editor.setAutocompleteProvider(providerFor(catalog, basePath));
  };
  useCatalog(NO_CATALOG);

  /** The ask cards this surface has not yet been told are closed. */
  const openAsks = new Map<string, AskFrame>();

  editor.onSubmit = (text: string): void => {
    if (text.trim() === '') return;
    options.sendLine(answerLine(text, openAsks));
  };

  /** One restore: `TuiAltScreen.stop` is not itself guarded, so guard it here. */
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    tui.stop();
  };

  /** The Ctrl+C hint is transient: any other key, or the window, clears it. */
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  let memory: KeyMemory = { lastCtrlC: undefined, exited: false };
  const clearHint = (): void => {
    if (hintTimer !== undefined) {
      clearTimeout(hintTimer);
      hintTimer = undefined;
    }
    if (status.hasHint()) {
      status.setHint(undefined);
      tui.requestRender();
    }
  };
  const showHint = (): void => {
    if (hintTimer !== undefined) clearTimeout(hintTimer);
    status.setHint(CTRL_C_HINT);
    tui.requestRender();
    hintTimer = setTimeout(() => {
      hintTimer = undefined;
      status.setHint(undefined);
      tui.requestRender();
    }, CTRL_C_WINDOW_MS);
  };

  tui.addChild(shell);
  tui.setFocus(editor);
  const effects: KeyEffects = {
    sendLine: options.sendLine,
    exit: options.onExit,
    clearEditor: (): void => { editor.setText(''); },
    clearHint,
    showHint,
    scroll: (action: KeyAction): boolean => {
      switch (action.kind) {
        case 'page':
          return transcript.page(action.delta);
        case 'line':
          return transcript.line(action.delta);
        case 'top':
          return transcript.toTop();
        case 'bottom':
          return transcript.toBottom();
        default:
          return false;
      }
    },
  };

  tui.addInputListener((data: string) => {
    const action = keyAction(data, editor.getText() === '');
    if (action === undefined) {
      // A printable key or a release: the hint no longer applies.
      if (memory.lastCtrlC !== undefined) {
        memory = { ...memory, lastCtrlC: undefined };
        clearHint();
      }
      return undefined;
    }
    if (action.kind !== 'ctrl-c') clearHint();
    const outcome = surfaceKey(
      action,
      memory,
      { editorEmpty: editor.getText() === '', menuOpen: editor.capturesViewportInput, now: Date.now() },
      effects,
    );
    memory = outcome.memory;
    if (!outcome.consumed) return undefined;
    // Esc closes the menu inside the Editor; the surface only redraws its own.
    tui.requestRender();
    return { consume: true };
  });

  // The alternate-screen renderer registers its own viewport listener first and
  // would consume PageUp/PageDown; this surface owns the transcript viewport, so
  // those two bindings are released back to `keyAction`.
  const bindings = getKeybindings();
  bindings.setUserBindings({
    ...bindings.getUserBindings(),
    'tui.altScreen.pageUp': [],
    'tui.altScreen.pageDown': [],
  });

  tui.start();
  // Registered only now that the surface owns the tty: nothing may restore a
  // screen that was never entered. The guard is idempotent because `stop` is.
  restoreOnExit(stop);
  if (options.title !== '') terminal.setTitle(`dsh-sup · ${options.title}`);

  return {
    push: (entry: MirrorItem | string): void => {
      transcript.push(entry);
      tui.requestRender();
    },
    setAsk: (frame: AskFrame): void => {
      // The closed frame carries no questions: a card that is over can only be
      // retired, and keeping it would let a stale id absorb a later bare answer.
      if ('closed' in frame) openAsks.delete(frame.id);
      else openAsks.set(frame.id, frame);
      transcript.push(renderAsk(frame));
      tui.requestRender();
    },
    setStatus: (next: Status): void => {
      status.set(next);
      tui.requestRender();
    },
    setCatalog: (catalog: Catalog): void => {
      useCatalog(catalog);
    },
    stop,
  };
}
