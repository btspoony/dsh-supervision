/**
 * The browsable attach surface: a scrollable transcript, a multi-line editor
 * and a status line, drawn by pi-tui over the forwarder's stdout.
 *
 * This module only runs when stdin and stdout are both terminals and
 * `--no-tui` is absent; a redirected stdout keeps the append-only line bytes
 * `routeFrame` already produces, because a supervisor parses those bytes.
 */

import {
  Editor,
  ProcessTerminal,
  TuiAltScreen,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Terminal,
} from '@earendil-works/pi-tui';
import { isProgramState, renderMirror, type MirrorItem, type ProgramState } from 'dsh-supervision-protocol';

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

/** The state an echo line reports, e.g. `[turn 3] working`; anything else is prose. */
export function echoStatus(text: string): Status | undefined {
  const match = /^\[turn (\d+)\] (\w+)$/.exec(text);
  const raw = match?.[2];
  if (match === null || raw === undefined || !isProgramState(raw)) return undefined;
  return { state: raw, turn: Number(match[1]) };
}

/** One attach surface: `tui` owns stdout, `line` is today's append-only path. */
export function chooseSurface(input: {
  readonly stdinTTY: boolean;
  readonly stdoutTTY: boolean;
  readonly noTui: boolean;
}): 'tui' | 'line' {
  return input.stdinTTY && input.stdoutTTY && !input.noTui ? 'tui' : 'line';
}

/** What one input sequence means to the surface, if anything. */
export type KeyAction =
  | { readonly kind: 'cancel' }
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
  // Ctrl+C cancels the running turn instead of leaving the attach; Ctrl+D is
  // the way out. Both are editor bindings by default, so they land here first.
  if (matchesKey(data, 'ctrl+c')) return { kind: 'cancel' };
  if (matchesKey(data, 'ctrl+d')) return { kind: 'exit' };
  if (matchesKey(data, 'pageUp')) return { kind: 'page', delta: -1 };
  if (matchesKey(data, 'pageDown')) return { kind: 'page', delta: 1 };
  if (!editorEmpty) return undefined;
  if (matchesKey(data, 'up')) return { kind: 'line', delta: -1 };
  if (matchesKey(data, 'down')) return { kind: 'line', delta: 1 };
  if (matchesKey(data, 'home')) return { kind: 'top' };
  if (matchesKey(data, 'end')) return { kind: 'bottom' };
  return undefined;
}

const THEME: EditorTheme = {
  borderColor: (text: string): string => text,
  selectList: {
    selectedPrefix: (text: string): string => text,
    selectedText: (text: string): string => text,
    description: (text: string): string => text,
    scrollInfo: (text: string): string => text,
    noMatch: (text: string): string => text,
  },
};

/** Session, state and turn, on one line above the editor. */
class StatusLine {
  private status: Status = {};

  set(next: Status): void {
    this.status = { ...this.status, ...next };
  }

  render(width: number): string {
    const parts = [this.status.session ?? 'dsh-sup'];
    if (this.status.state !== undefined) parts.push(this.status.state);
    if (this.status.turn !== undefined) parts.push(`turn ${String(this.status.turn)}`);
    return truncateToWidth(parts.join(' · '), width);
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

  /**
   * @param wrapEntry - one entry's lines; injectable so a test can count calls.
   * @param width - the width to wrap at until a render names the real one.
   */
  constructor(
    wrapEntry: (entry: MirrorItem | string, width: number) => string[] = renderEntry,
    width = 80,
  ) {
    this.wrapEntry = wrapEntry;
    this.width = Math.max(1, Math.floor(width));
  }

  push(entry: MirrorItem | string): void {
    this.entries.push(entry);
    // Only the new entry is wrapped; the history stays as the last frame left it.
    append(this.flat, this.wrapEntry(entry, this.width));
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
    if (marker !== undefined) visible.push(truncateToWidth(marker, w));
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
    for (const entry of this.entries) append(this.flat, this.wrapEntry(entry, width));
  }
}

/** One entry's lines at a width; the only place an entry is rendered. */
function renderEntry(entry: MirrorItem | string, width: number): string[] {
  return fitLines(typeof entry === 'string' ? entry : renderMirror(entry, width), width);
}

/** Appends in place; a spread would give a huge block one call frame per line. */
function append(into: string[], lines: readonly string[]): void {
  for (const line of lines) into.push(line);
}

/** Transcript, editor and status stacked into exactly the terminal's rows. */
class Shell implements Component {
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
    const w = Math.max(20, Math.floor(width) || this.fallbackWidth || 80);
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
  setStatus(status: Status): void;
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
  const transcript = new TranscriptView();
  const status = new StatusLine();
  const editor = new Editor(tui, THEME);
  const shell = new Shell(terminal, transcript, editor, status, options.width ?? 80);

  editor.onSubmit = (text: string): void => {
    if (text.trim() === '') return;
    options.sendLine(text);
  };

  /** One restore: `TuiAltScreen.stop` is not itself guarded, so guard it here. */
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    tui.stop();
  };

  tui.addChild(shell);
  tui.setFocus(editor);
  tui.addInputListener((data: string) => {
    const action = keyAction(data, editor.getText() === '');
    if (action === undefined) return undefined;
    switch (action.kind) {
      case 'cancel':
        options.sendLine('/cancel');
        break;
      case 'exit':
        options.onExit();
        break;
      case 'page':
        if (transcript.page(action.delta)) tui.requestRender();
        break;
      case 'line':
        if (transcript.line(action.delta)) tui.requestRender();
        break;
      case 'top':
        if (transcript.toTop()) tui.requestRender();
        break;
      case 'bottom':
        if (transcript.toBottom()) tui.requestRender();
        break;
    }
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
    setStatus: (next: Status): void => {
      status.set(next);
      tui.requestRender();
    },
    stop,
  };
}
