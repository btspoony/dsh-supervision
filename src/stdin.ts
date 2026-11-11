/**
 * The stdin line grammar, kept pure: the forwarder splits stdin into lines and
 * the plugin only decides what each line means. No socket, agent, or process
 * state here, so the table in the ADR is testable verbatim.
 */

/** One parsed input line; anything that reaches the agent is a `steer`. */
export type Command =
  | { readonly kind: 'steer'; readonly text: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'status' }
  | { readonly kind: 'new'; readonly cwd: string | undefined }
  | { readonly kind: 'attach'; readonly session: string }
  | { readonly kind: 'approve'; readonly ask: string }
  | { readonly kind: 'reject'; readonly ask: string }
  | { readonly kind: 'yes' }
  | { readonly kind: 'no' }
  | { readonly kind: 'unknown'; readonly verb: string }

/** The complete lines of a chunk and the unterminated tail behind them. */
export interface Split {
  readonly lines: readonly string[]
  readonly rest: string
}

/** A bracketed-paste wrapper around one whole line. */
const PASTE = /^\u001b\[200~([\s\S]*)\u001b\[201~$/

/**
 * Strip a bracketed-paste wrapper; hc sends raw text, but a terminal in front
 * of it may still wrap a line.
 * @param line - the line without its terminator.
 * @returns the inner text, or the line unchanged.
 */
function stripPaste(line: string): string {
  const matched = PASTE.exec(line)
  return matched?.[1] ?? line
}

/**
 * Parse one stdin line.
 * @param line - one line, with or without its terminator.
 * @returns the command, or undefined for a blank line (never forwarded as a steer).
 */
export function parseLine(line: string): Command | undefined {
  // Trailing CR/LF only: everything after the line break is framing, and any
  // other whitespace is the human's own text.
  const text = stripPaste(line.replace(/[\r\n]+$/, ''))
  if (text.trim() === '') return undefined
  if (!text.startsWith('/')) return { kind: 'steer', text }

  const [verb = '', ...args] = text.slice(1).trim().split(/\s+/)
  switch (verb) {
    case 'cancel':
      return args.length === 0 ? { kind: 'cancel' } : { kind: 'unknown', verb }
    case 'status':
      return args.length === 0 ? { kind: 'status' } : { kind: 'unknown', verb }
    case 'y':
      return args.length === 0 ? { kind: 'yes' } : { kind: 'unknown', verb }
    case 'n':
      return args.length === 0 ? { kind: 'no' } : { kind: 'unknown', verb }
    case 'new': {
      const [cwd] = args
      if (args.length === 0) return { kind: 'new', cwd: undefined }
      if (args.length > 1 || cwd === undefined || cwd === '') return { kind: 'unknown', verb }
      return { kind: 'new', cwd }
    }
    case 'attach': {
      const [session, ...rest] = args
      if (rest.length > 0 || session === undefined || !session.startsWith('session-')) {
        return { kind: 'unknown', verb }
      }
      return { kind: 'attach', session }
    }
    case 'approve':
    case 'reject': {
      const [ask, ...rest] = args
      if (rest.length > 0 || ask === undefined || ask === '') return { kind: 'unknown', verb }
      return verb === 'approve' ? { kind: 'approve', ask } : { kind: 'reject', ask }
    }
    default:
      return { kind: 'unknown', verb }
  }
}

/**
 * Split raw stdin text into lines on `\n`, `\r\n` or a lone `\r`.
 * @param rest - the unterminated tail of the previous chunk.
 * @param chunk - the text just read.
 * @returns the complete lines, and the tail to prepend to the next chunk.
 */
export function splitLines(rest: string, chunk: string): Split {
  const text = rest + chunk
  const lines = text.split(/\r\n|\r|\n/)
  // shortcut: a chunk ending on a lone `\r` may split a `\r\n` pair, which the
  // empty line then absorbs; parseLine drops blanks, so no command is lost.
  const tail = lines.pop() ?? ''
  return { lines, rest: tail }
}
