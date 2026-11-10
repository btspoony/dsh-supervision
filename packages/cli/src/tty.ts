import { closeSync, openSync, writeSync } from 'node:fs';

export type Tty =
  | { readonly ok: true; readonly write: (text: string) => void; readonly close: () => void }
  | { readonly ok: false; readonly error: string };

/**
 * Opens the reporting surface: `/dev/tty` first (herdr-core reads that, not our
 * stdout), then stdout when it is a TTY. One synchronous writer serves OSC and
 * echo lines alike, so interleaved frames cannot splice into each other.
 */
export function openTty(): Tty {
  let fd: number | undefined;
  try {
    fd = openSync('/dev/tty', 'w');
  } catch {
    fd = undefined;
  }

  if (fd !== undefined) {
    const handle = fd;
    return {
      ok: true,
      write: (text: string) => {
        writeSync(handle, text);
      },
      close: () => {
        try {
          closeSync(handle);
        } catch {
          // Already closed by the OS at process exit.
        }
      },
    };
  }

  if (process.stdout.isTTY === true) {
    return {
      ok: true,
      write: (text: string) => {
        process.stdout.write(text);
      },
      close: () => {},
    };
  }

  return { ok: false, error: 'no tty: /dev/tty is unavailable and stdout is not a terminal' };
}
