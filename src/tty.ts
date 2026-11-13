/**
 * The production `TtyIO`: the process's own terminal. The write side is
 * `/dev/tty` (what herdr-core reads), falling back to stdout when it is a TTY;
 * the read side is stdin, and only a terminal stdin is accepted, split with
 * `splitLines` so CRLF across chunks and bracketed pastes behave exactly as
 * they do for the forwarder. Nothing here throws: a missing terminal is a
 * reported reason, not a dead `dsh web`, and a failed write is reported to the
 * caller rather than raised into the host.
 *
 * The terminal stays in the driver's own line mode. Raw mode disables ISIG,
 * ECHO, IXON and line editing, which steals Ctrl+C, Ctrl+Z, Ctrl+\\, Ctrl+S/Q
 * and input echo from the operator; the bridge only needs whole lines, and line
 * mode already delivers those.
 */

import { createWriteStream, openSync } from 'node:fs'
import { splitLines } from './stdin.js'
import type { TtyIO } from './tty-transport.js'

export type TtyOpen =
  | { readonly ok: true; readonly io: TtyIO }
  | { readonly ok: false; readonly reason: string }

/** The write half of a terminal: `/dev/tty`, or stdout as the fallback. */
export interface TtyWriter {
  write(text: string): boolean
  close(): void
}

/** A terminal writer or the reason this process has none. */
export type TtyWriterOpen =
  | { readonly ok: true; readonly writer: TtyWriter }
  | { readonly ok: false; readonly reason: string }

/** The stdin surface `lineFeed` needs, so a fake stream can stand in for it. */
export interface LineSource {
  setEncoding(encoding: BufferEncoding): unknown
  on(event: 'data', listener: (chunk: string) => void): unknown
  on(event: 'end', listener: () => void): unknown
  off(event: 'data', listener: (chunk: string) => void): unknown
  off(event: 'end', listener: () => void): unknown
  resume(): unknown
  pause(): unknown
}

/** The stdin surface `openTtyIO` needs, so a stub can stand in for a real one. */
export type TtyStdin = LineSource & {
  readonly isTTY?: boolean
}

/**
 * stdin as an async feed of complete lines, with a way to stop waiting on it.
 * Data read before anyone reads the feed is buffered, so a line typed during
 * the initial hello is handled in order afterwards.
 */
export function lineFeed(input: LineSource): { lines(): AsyncIterable<string>; stop(): void } {
  const complete: string[] = []
  let rest = ''
  let stopped = false
  let wake: (() => void) | undefined

  const onData = (chunk: string): void => {
    const split = splitLines(rest, chunk)
    rest = split.rest
    // A loop, not a spread: one large paste is more lines than the argument cap.
    for (const line of split.lines) complete.push(line)
    wake?.()
  }
  const onEnd = (): void => {
    stopped = true
    wake?.()
  }

  input.setEncoding('utf8')
  input.on('data', onData)
  input.on('end', onEnd)
  input.resume()

  return {
    async *lines(): AsyncGenerator<string> {
      for (;;) {
        const line = complete.shift()
        if (line !== undefined) {
          yield line
          continue
        }
        if (stopped) return
        // The repo targets ES2022, so `Promise.withResolvers` is unavailable.
        await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
      }
    },
    stop(): void {
      if (stopped) return
      stopped = true
      // The buffered lines were typed for a session that no longer has a
      // reader: replaying them onto a stopped feed is how an orphan session
      // gets created, so the queue dies with the feed.
      complete.length = 0
      rest = ''
      input.off('data', onData)
      input.off('end', onEnd)
      input.pause()
      wake?.()
    },
  }
}

/**
 * A non-blocking writer over an open terminal fd. A synchronous write stalls the
 * whole host when the operator presses Ctrl+S (XOFF stops pty output); with a
 * stream the records queue in order and the event loop keeps servicing sessions,
 * socket frames and approvals until Ctrl+Q resumes the terminal.
 * @param fd - an open writable terminal fd; the stream owns closing it.
 * @returns the writer the transport renders frames through.
 */
function streamWriter(fd: number): TtyWriter {
  const stream = createWriteStream('', { fd, autoClose: true })
  // A pty that vanished (`EIO`) or a stale fd (`EBADF`) surfaces here; the next
  // write reports the dead surface so the caller finishes the bridge instead of
  // throwing into a host emitter.
  let dead = false
  stream.on('error', () => { dead = true })
  return {
    write: text => {
      if (dead || stream.destroyed) return false
      try {
        stream.write(text)
        return true
      } catch {
        dead = true
        return false
      }
    },
    close: () => {
      try {
        stream.end()
      } catch {
        // Already closed by the OS at process exit.
      }
    },
  }
}

/**
 * Open the process's own terminal for reporting.
 * @returns the writer, or the reason neither `/dev/tty` nor a TTY stdout exists.
 */
export function openDevTty(): TtyWriterOpen {
  try {
    const fd = openSync('/dev/tty', 'w')
    return { ok: true, writer: streamWriter(fd) }
  } catch {
    // A container, a remote shell or a redirected `dsh web` has no `/dev/tty`;
    // stdout is the honest second choice, and a pipe is no surface at all.
    if (process.stdout.isTTY !== true) {
      return { ok: false, reason: 'no tty: /dev/tty is unavailable and stdout is not a terminal' }
    }
    return { ok: true, writer: stdoutWriter(process.stdout) }
  }
}

/** The stdout surface `stdoutWriter` writes to; a stub stands in for it. */
export interface StdoutLike {
  write(text: string): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  readonly destroyed?: boolean
}

/**
 * The fallback writer. It shares the primary writer's failure contract: a
 * vanished pty emits `error` on stdout, and an unhandled one would take down
 * the host, so the surface goes dead and the caller finishes the bridge.
 * @param stdout - the process's stdout, or a stub in a test.
 * @returns the writer the transport renders frames through.
 */
export function stdoutWriter(stdout: StdoutLike = process.stdout): TtyWriter {
  let dead = false
  stdout.on('error', () => { dead = true })
  return {
    write: text => {
      if (dead || stdout.destroyed === true) return false
      try {
        stdout.write(text)
        return true
      } catch {
        dead = true
        return false
      }
    },
    close: () => {},
  }
}

/**
 * Opens the reporting surface and the owning keyboard.
 * @param stdin - the process's own stdin, or a stub in a test.
 * @param openWriter - the terminal writer opener; a stub stands in for `/dev/tty`.
 * @returns the io, or the reason no surface exists.
 */
export function openTtyIO(
  stdin: TtyStdin = process.stdin,
  openWriter: () => TtyWriterOpen = openDevTty,
): TtyOpen {
  // The read side is the owner's keyboard or nothing: a redirected stdin is a
  // pipe any writer can feed, and treating it as the owner would hand it the
  // command channel. Checked first, so a refusal opens no fd.
  if (stdin.isTTY !== true) {
    return { ok: false, reason: 'no tty: stdin is not a terminal' }
  }
  const opened = openWriter()
  if (!opened.ok) return opened
  const { write, close: closeWriter } = opened.writer

  // The driver's own line mode is kept: editing, echo, Ctrl+C/Z/\\ and Ctrl+S/Q
  // behave exactly as they do without the plugin, while stdin still yields
  // complete lines.
  const feed = lineFeed(stdin)
  let closed = false

  return {
    ok: true,
    io: {
      write,
      lines: () => feed.lines(),
      close: () => {
        if (closed) return
        closed = true
        feed.stop()
        closeWriter()
      },
    },
  }
}
