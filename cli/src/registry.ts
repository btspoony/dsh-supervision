import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Backend discovery: registry entries, liveness, and backend selection.
 * `readEntries` takes its directory and `selectEntry` takes a liveness probe, so
 * tests supply a temp dir and a fake pid check instead of a real `dsh web`.
 */

/** One `$DSH_HOME/supervision/<pid>-<8hex>.json` entry, as written by the plugin. */
export interface RegistryEntry {
  readonly proto: 1;
  readonly pid: number;
  readonly socket: string;
  readonly startedAt: number;
  readonly dshVersion: string;
}

export type Selection =
  | { readonly entry: RegistryEntry }
  | { readonly error: 'none' | 'ambiguous'; readonly entries: readonly RegistryEntry[] };

/** `$DSH_HOME/supervision`, the directory the plugin writes entries into. */
export function resolveSocketDir(env: NodeJS.ProcessEnv): string {
  return join(env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'supervision');
}

/** Every parseable entry in `dir`; unreadable or foreign files are skipped, never deleted. */
export function readEntries(dir: string): RegistryEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: RegistryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const entry = parseEntry(raw);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/** Parses one registry file's JSON; `undefined` means malformed or foreign. */
export function parseEntry(raw: unknown): RegistryEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const { proto, pid, socket, startedAt, dshVersion } = raw;
  if (proto !== 1) return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof socket !== 'string' || socket === '') return undefined;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
  if (typeof dshVersion !== 'string') return undefined;
  return { proto: 1, pid, socket, startedAt, dshVersion };
}

/**
 * Stale means a dead pid or a socket file that is gone. `EPERM` counts as alive:
 * the process exists but belongs to another user, so we cannot ask it anything.
 */
export function isLive(entry: RegistryEntry): boolean {
  try {
    process.kill(entry.pid, 0);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) return false;
  }
  return existsSync(entry.socket);
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
