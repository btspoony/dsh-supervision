/**
 * Line framing for stdin: herdr-core pastes text and then submits with a bare
 * `\r`, so `\r` and `\n` are both terminators and a CRLF is one terminator, not
 * two. Pure, so framing is tested without a stdin stream.
 */
export interface Split {
  readonly lines: readonly string[];
  /** Text after the last terminator, withheld until the next chunk. */
  readonly rest: string;
  /**
   * The chunk ended on a `\r` that already terminated a line, so the `\n`
   * opening the next chunk is the second half of that CRLF, not a terminator.
   */
  readonly pendingCr: boolean;
}

/**
 * Splits `chunk` onto `rest`, emitting one line per CR, LF or CRLF. A CR at the
 * end of a chunk cannot know yet whether its LF follows, so it terminates a
 * line immediately (a bare CR submits) and sets `pendingCr` for the next call.
 */
export function splitLines(rest: string, chunk: string, pendingCr = false): Split {
  const text = rest + (pendingCr && chunk.startsWith('\n') ? chunk.slice(1) : chunk);
  const parts = text.split(/\r\n|\r|\n/);
  return { lines: parts.slice(0, -1), rest: parts[parts.length - 1] ?? '', pendingCr: text.endsWith('\r') };
}

/**
 * Builds the stdin chunk handler, keeping the frame state between chunks. A
 * blank line is a line: the plugin's grammar ignores it, so dropping it here
 * would only hide an intentional empty submission.
 */
export function lineForwarder(forward: (line: string) => void): (chunk: string) => void {
  let rest = '';
  let pendingCr = false;
  return (chunk: string) => {
    const split = splitLines(rest, chunk, pendingCr);
    rest = split.rest;
    pendingCr = split.pendingCr;
    for (const line of split.lines) forward(line);
  };
}
