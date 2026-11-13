/**
 * Where one decoded frame goes. The machine sink (`/dev/tty`) is what
 * herdr-core reads; the human sink (stdout) is the transcript a person sees.
 * Only a frame with a human-facing line reaches both, and only when stdout is
 * a terminal — a redirected stdout stays machine-clean.
 */

import { renderFrame, renderMirror, type OutFrame } from 'dsh-supervision-protocol';

/** Stdout's width when it has none: a pipe, or a test. */
const FALLBACK_WIDTH = 100;

/**
 * Routes one frame to the sinks that may write it.
 * @param frame - a validated frame from the plugin.
 * @param human - whether stdout is a terminal and may carry transcript lines.
 * @returns the bytes for each sink; either is absent when that sink has nothing.
 */
export function routeFrame(frame: OutFrame, human: boolean): { tty?: string; out?: string } {
  switch (frame.t) {
    case 'osc':
      // Opaque record for the machine surface; it carries its own terminator.
      return { tty: frame.data };
    case 'echo':
      // State, turns and asks: the machine surface needs them, a person wants them too.
      return human ? { tty: `${frame.text}\n`, out: `${frame.text}\n` } : { tty: `${frame.text}\n` };
    case 'mirror':
      // `renderMirror` never terminates a block; the sink that writes lines adds the newline.
      return human ? { out: `${renderMirror(frame.item, process.stdout.columns ?? FALLBACK_WIDTH)}\n` } : {};
    case 'welcome':
    case 'sessions':
    case 'error':
    case 'bye':
      return { tty: renderFrame(frame) };
  }
}
