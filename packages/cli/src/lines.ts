/**
 * Line framing for stdin: herdr-core pastes text and then submits with a bare
 * `\r`, so `\r` and `\n` are both terminators and a CRLF is one terminator, not
 * two. Pure, so framing is tested without a stdin stream.
 */
export interface Split {
  readonly lines: readonly string[];
  /** Text after the last terminator, withheld until the next chunk. */
  readonly rest: string;
}

/** Splits `chunk` onto `rest`, emitting one line per CR, LF or CRLF. */
export function splitLines(rest: string, chunk: string): Split {
  const parts = (rest + chunk).replace(/\r\n/g, '\n').split(/[\r\n]/);
  return { lines: parts.slice(0, -1), rest: parts[parts.length - 1] ?? '' };
}
