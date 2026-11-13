/**
 * The production `TtyIO`: the process's own terminal. The write side is
 * `/dev/tty` (what herdr-core reads), falling back to stdout when it is a TTY;
 * the read side is stdin, and only a terminal stdin is accepted, split with
 * `splitLines` so CRLF across chunks and bracketed pastes behave exactly as
 * they do for the forwarder. Nothing here throws: a missing terminal is a
 * reported reason, not a dead `dsh web`, and a failed write is reported to the
 * caller rather than raised into the host.
 */

import { closeSync, openSync, writeSync } from 'node:fs'
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

/**
 * Open the process's own terminal for reporting.
 * @returns the writer, or the reason neither `/dev/tty` nor a TTY stdout exists.
 */
export function openDevTty(): TtyWriterOpen {
  try {
    const fd = openSync('/dev/tty', 'w')
    // shortcut: the write is still synchronous, so a stopped pty (Ctrl-S) will
    // stall this process's event loop. An async sink would buffer without bound
    // instead, which is worse in-process; upgrade when the terminal can be
    // written from a child process or with bounded buffering.
    return {
      ok: true,
      writer: {
        write: text => {
          try {
            writeSync(fd, text)
            return true
          } catch {
            // A pty that went away (`EIO`) or a stale fd (`EBADF`) is a dead
            // surface; the caller finishes the bridge instead of throwing here,
            // where a host emitter would turn it into a dead `dsh web`.
            return false
          }
        },
        close: () => {
          try {
            closeSync(fd)
          } catch {
            // Already closed by the OS at process exit.
          }
        },
      },
    }
  } catch {
    // A container, a remote shell or a redirected `dsh web` has no `/dev/tty`;
    // stdout is the honest second choice, and a pipe is no surface at all.
    if (process.stdout.isTTY !== true) {
      return { ok: false, reason: 'no tty: /dev/tty is unavailable and stdout is not a terminal' }
    }
    return {
      ok: true,
      writer: {
        write: text => {
          // A full stdout buffer is backpressure, not a dead surface; a vanished
          // pipe reports through `error` on the stream, never through this value.
          process.stdout.write(text)
          return true
        },
        close: () => {},
      },
    }
  }
}

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
  readonly isRaw?: boolean
  setRawMode?(raw: boolean): void
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
 * Opens the reporting surface and the owning keyboard.
 * @param stdin - the process's own stdin, or a stub in a test.
 * @param interrupt - delivers the stop signal a raw-mode Ctrl+C stands for;
 *   injectable so a test never signals its own runner.
 * @returns the io, or the reason neither surface exists.
 */
export function openTtyIO(
  stdin: TtyStdin = process.stdin,
  interrupt: () => void = () => { process.kill(process.pid, 'SIGINT') },
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

  // A terminal stdin is guaranteed above, so `setRawMode` is present in
  // production; the optional call keeps a test stub without it usable.
  const input = stdin
  /** The mode the host was in when we mounted; restored whenever unbridged. */
  const previousRaw = input.isRaw === true
  const setMode = (raw: boolean): void => { input.setRawMode?.(raw) }
  const feed = lineFeed(input)
  let closed = false
  // Raw mode disables the terminal's ISIG, so Ctrl+C arrives as a byte and
  // would otherwise be swallowed as stray input. A supervisor must never eat
  // its own stop key: restore the terminal, then hand the host the signal that
  // byte stands for.
  const onInterrupt = (chunk: string): void => {
    if (!chunk.includes('\u0003')) return
    setMode(previousRaw)
    interrupt()
  }
  input.on('data', onInterrupt)

  return {
    ok: true,
    io: {
      write,
      lines: () => feed.lines(),
      // Raw only while a bridge is bound: cooked mode keeps line editing normal
      // for the `/new` and `/attach` re-entry lines.
      setRaw: raw => { setMode(raw ? true : previousRaw) },
      close: () => {
        if (closed) return
        closed = true
        input.off('data', onInterrupt)
        feed.stop()
        setMode(previousRaw)
        closeWriter()
      },
    },
  }
}
