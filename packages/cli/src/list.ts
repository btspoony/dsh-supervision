import type { ErrorCode, RegistryEntry, SessionItem } from 'dsh-supervision-protocol';
import { connect, type Connection } from './connection.js';
import { EXIT, exitCodeFor } from './exit.js';

// PID identifies the backend when several `dsh web` processes are live; the
// registry entry is the only place a listing knows it, so the row carries it.
// Widths are computed, not tab-separated: a long cwd or session id must not
// push the trailing columns out of alignment.
const COLUMNS = ['SESSION', 'PID', 'CWD', 'LIVE', 'BRIDGED'];
const GUTTER = '  ';

/** Pad every cell to its column's width; the last column stays unpadded. */
function tableLine(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
    .join(GUTTER);
}

/**
 * One backend's answer to `list`: its rows, or the protocol code that decides
 * the exit. A lost socket or a `bye` has no code — that is a genuinely lost
 * backend — while a locally refused frame is `protocol`.
 */
export type ListResult =
  | { readonly ok: true; readonly items: readonly SessionItem[] }
  | { readonly ok: false; readonly code?: ErrorCode };

/**
 * Asks one backend for its sessions. A backend that cannot answer has already
 * put its reason on stderr, so the failure carries no message of its own.
 */
export function listFrom(socket: string, cwd: string | undefined): Promise<ListResult> {
  return new Promise((resolve) => {
    let connection: Connection | undefined;
    const settle = (result: ListResult): void => {
      connection?.close();
      resolve(result);
    };
    connection = connect(socket, undefined, {
      onFrame: (frame) => {
        if (frame.t === 'sessions') settle({ ok: true, items: frame.items });
        if (frame.t === 'bye') {
          // Several backends answer at once, so the reason alone would leave the
          // operator guessing which one left; the socket names it.
          process.stderr.write(`${socket}: ${frame.reason}\n`);
          settle({ ok: false });
        }
        if (frame.t === 'error') {
          process.stderr.write(`${frame.code}: ${frame.message}\n`);
          settle({ ok: false, code: frame.code });
        }
      },
      onLost: (_msg, detail) => {
        // Same attribution as the `bye` arm: several backends answer at once.
        process.stderr.write(`${socket}: ${detail}\n`);
        settle({ ok: false });
      },
      onRefused: (detail) => {
        process.stderr.write(`${detail}\n`);
        settle({ ok: false, code: 'protocol' });
      },
    });
    connection.send(cwd === undefined ? { t: 'list' } : { t: 'list', cwd });
  });
}

/**
 * Prints the union of every live backend's sessions. A listing binds no bridge,
 * so it needs no welcome and takes no session; it still fails when a backend
 * the registry called live could not answer. A genuinely lost backend outranks
 * a local refusal, so that refusal never erases the loss.
 */
export async function runList(entries: readonly RegistryEntry[], cwd: string | undefined): Promise<number> {
  const results = await Promise.all(entries.map((entry) => listFrom(entry.socket, cwd)));
  const rows = entries.flatMap((entry, index) => {
    const result = results[index];
    // A failed backend contributed no rows; its reason is already on stderr.
    if (result === undefined || !result.ok) return [];
    return result.items.map((item) => [
      item.id,
      String(entry.pid),
      item.cwd,
      item.live ? 'yes' : 'no',
      item.bridged ? 'yes' : '-',
    ]);
  });
  const widths = COLUMNS.map((name, index) =>
    Math.max(name.length, ...rows.map((row) => row[index]?.length ?? 0)));
  process.stdout.write(`${[COLUMNS, ...rows].map((cells) => tableLine(cells, widths)).join('\n')}\n`);
  // The registry order is unsorted `readdirSync`, so the exit must not depend on
  // which failure came first. A bare loss outranks every coded refusal: exit 6
  // means the backend is alive, so letting a local refusal win would erase a
  // backend that really is gone. Only when every failure carries a code does
  // that code decide; two distinct codes tie-break by name, which keeps even
  // that case order-free.
  const failed = results.filter((result) => !result.ok);
  if (failed.some((result) => result.code === undefined)) return EXIT.backendLost;
  if (failed.length === 0) return EXIT.ok;
  const codes = failed.flatMap((result) => (result.code === undefined ? [] : [result.code])).sort();
  return exitCodeFor(codes[0] ?? '');
}
