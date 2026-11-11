/**
 * The production `TtyIO`: the process's own terminal. The write side is
 * `/dev/tty` (what herdr-core reads), falling back to stdout when it is a TTY;
 * the read side is stdin, split with `splitLines` so CRLF across chunks and
 * bracketed pastes behave exactly as they do for the forwarder. Nothing here
 * throws: a missing terminal is a reported reason, not a dead `dsh web`.
 */

import { closeSync, openSync, writeSync } from 'node:fs'
import { splitLines } from './stdin.js'
import type { TtyIO } from './tty-transport.js'

export type TtyOpen =
  | { readonly ok: true; readonly io: TtyIO }
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
    complete.push(...split.lines)
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
      input.off('data', onData)
      input.off('end', onEnd)
      input.pause()
      wake?.()
    },
  }
}

/**
 * Opens the reporting surface and the owning keyboard.
 * @returns the io, or the reason neither surface exists.
 */
export function openTtyIO(): TtyOpen {
  let write: (text: string) => void
  let closeWriter: () => void

  try {
    const fd = openSync('/dev/tty', 'w')
    write = text => { writeSync(fd, text) }
    closeWriter = () => {
      try {
        closeSync(fd)
      } catch {
        // Already closed by the OS at process exit.
      }
    }
  } catch {
    // A container, a remote shell or a redirected `dsh web` has no `/dev/tty`;
    // stdout is the honest second choice, and a pipe is no surface at all.
    if (process.stdout.isTTY !== true) {
      return { ok: false, reason: 'no tty: /dev/tty is unavailable and stdout is not a terminal' }
    }
    write = text => { process.stdout.write(text) }
    closeWriter = () => {}
  }

  const input = process.stdin
  // `setRawMode` exists only on a terminal; a piped stdin has no mode to change.
  const setMode = typeof input.setRawMode === 'function'
    ? (raw: boolean): void => { input.setRawMode(raw) }
    : undefined
  /** The mode the host was in when we mounted; restored whenever unbridged. */
  const previousRaw = input.isRaw === true
  const feed = lineFeed(input)
  let closed = false

  return {
    ok: true,
    io: {
      write,
      lines: () => feed.lines(),
      // Raw only while a bridge is bound: cooked mode keeps line editing normal
      // for the `/new` and `/attach` re-entry lines.
      setRaw: raw => { setMode?.(raw ? true : previousRaw) },
      close: () => {
        if (closed) return
        closed = true
        feed.stop()
        setMode?.(previousRaw)
        closeWriter()
      },
    },
  }
}
