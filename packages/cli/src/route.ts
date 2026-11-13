/**
 * Where one decoded frame goes. The machine sink (`/dev/tty`) is what
 * herdr-core reads; the human sink (stdout) is the transcript a person sees.
 * Each line lands on exactly one sink — on an interactive attach both are the
 * same screen, so writing a line to both would print it twice.
 */

import { renderFrame, renderMirror, type OutFrame } from 'dsh-supervision-protocol';

/**
 * Routes one frame to the sink that may write it.
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
      // State, turns and asks: a person wants them, and a redirected stdout
      // still needs the supervisor to see them, so the line picks one sink.
      return human ? { out: `${frame.text}\n` } : { tty: `${frame.text}\n` };
    case 'mirror': {
      // `renderMirror` never terminates a block; the sink that writes lines adds
      // the newline. A pty can report 0 columns, which would wrap at width 1, so
      // `||` rather than `??` lets a missing or zero width take the renderer's own
      // default instead of a second constant here.
      const width = process.stdout.columns || undefined;
      return human ? { out: `${renderMirror(frame.item, width)}\n` } : {};
    }
    case 'error':
      // Unreachable from `main.ts`, which settles on the code before routing: kept
      // so this table stays complete over `OutFrame`. A caller that routed it
      // instead would silently drop the exit code, so keep that arm first.
      return { tty: renderFrame(frame) };
    case 'welcome':
    case 'sessions':
    case 'bye':
      return { tty: renderFrame(frame) };
  }
}
