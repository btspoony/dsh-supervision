import type { RegistryEntry } from 'dsh-supervision-protocol';

/**
 * Backend selection policy: which of the live registry entries a command may
 * talk to. The entry shape, the directory and pid liveness are the shared
 * protocol; only the CLI's none/single/ambiguous rule lives here.
 */

export type Selection =
  | { readonly entry: RegistryEntry }
  | { readonly error: 'none' | 'ambiguous'; readonly entries: readonly RegistryEntry[] };

/**
 * The entries a command may talk to: `--pid` narrows, and a stale entry is not a
 * candidate at all. That makes "one running backend" the rule rather than "one
 * file", so a crashed plugin never blocks the next start.
 */
export function liveEntries(
  entries: readonly RegistryEntry[],
  liveness: (entry: RegistryEntry) => boolean,
  pid?: number,
): RegistryEntry[] {
  return entries.filter((entry) => (pid === undefined || entry.pid === pid) && liveness(entry));
}

/**
 * Picks the single backend a bridge may bind; `list` skips this because it
 * enumerates every live entry instead of needing exactly one.
 */
export function selectEntry(
  entries: readonly RegistryEntry[],
  liveness: (entry: RegistryEntry) => boolean,
  pid?: number,
): Selection {
  const live = liveEntries(entries, liveness, pid);
  const [first, second] = live;
  if (first === undefined) return { error: 'none', entries: live };
  if (second !== undefined) return { error: 'ambiguous', entries: live };
  return { entry: first };
}
