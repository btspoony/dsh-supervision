import type { ErrorCode, RegistryEntry, SessionItem } from 'dsh-supervision-protocol';
import { connect, type Connection } from './connection.js';
import { EXIT, exitCodeFor } from './exit.js';

const HEADER = ['SESSION', 'CWD', 'LIVE', 'BRIDGED'].join('\t');

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
export function listFrom(socket: string, cwd: string): Promise<ListResult> {
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
    connection.send({ t: 'list', cwd });
  });
}

/**
 * Prints the union of every live backend's sessions. A listing binds no bridge,
 * so it needs no welcome and takes no session; it still fails when a backend
 * the registry called live could not answer. A genuinely lost backend outranks
 * a local refusal, so that refusal never erases the loss.
 */
export async function runList(entries: readonly RegistryEntry[], cwd: string): Promise<number> {
  const results = await Promise.all(entries.map((entry) => listFrom(entry.socket, cwd)));
  const rows = results
    .flatMap((result) => (result.ok ? result.items : []))
    .map((item) => `${item.id}\t${item.cwd}\t${item.live ? 'yes' : 'no'}\t${item.bridged ? 'yes' : '-'}`);
  process.stdout.write(`${[HEADER, ...rows].join('\n')}\n`);
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
