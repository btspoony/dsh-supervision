/**
 * The supervision registry: `$DSH_HOME/supervision/<pid>-<8hex>.json`, one per
 * `dsh web` process, each naming the socket that process serves. Reading is
 * split by trust: a malformed entry is skipped for selection, and removed only
 * by {@link reclaimStale}, which the plugin runs before it writes its own.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROTO, isRecord } from './frames.js'

/** Registry entry as written to `<pid>-<8hex>.json`. */
export interface RegistryEntry {
  readonly proto: number
  readonly pid: number
  readonly socket: string
  readonly startedAt: number
  readonly dshVersion: string
}

/** The two paths one plugin instance owns. */
export interface RegistryPaths {
  readonly socket: string
  readonly json: string
}

/**
 * The registry directory: `$DSH_HOME/supervision`, `~/.dsh` when unset.
 * @returns an absolute path; nothing is created here.
 */
export function supervisionDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'supervision')
}

/**
 * The paths for one instance. The session id never appears in a path: a Unix
 * socket path is capped near 103 bytes and an id would overflow it.
 * @param dir - the supervision directory.
 * @param pid - the owning process.
 * @param token - 8 hex characters, unique per instance in that process.
 */
export function registryPaths(dir: string, pid: number, token: string): RegistryPaths {
  const stem = join(dir, `${String(pid)}-${token}`)
  return { socket: `${stem}.sock`, json: `${stem}.json` }
}

/** @returns 8 random hex characters, the per-instance collision breaker. */
export function newToken(): string {
  return randomBytes(4).toString('hex')
}

/**
 * Prove a registry entry's shape. `JSON.parse` output is `unknown` until this
 * returns; a half-written or hand-edited file must never reach the transport.
 * @param value - parsed JSON.
 * @returns true when every field has the type the protocol promises.
 */
export function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (!isRecord(value)) return false
  const { proto, pid, socket, startedAt, dshVersion } = value
  return proto === PROTO
    && typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
    && typeof socket === 'string' && socket !== ''
    && typeof startedAt === 'number' && Number.isFinite(startedAt)
    && typeof dshVersion === 'string'
}

/**
 * Create the supervision directory with `0700`.
 * @param dir - absolute path.
 */
export function ensureRegistryDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdirSync's mode is masked by the umask and ignored on an existing directory.
  chmodSync(dir, 0o700)
}

/**
 * @param pid - the process to test.
 * @returns true when the process exists.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM is a live process owned by someone else. It cannot happen for a
    // same-user socket, but mistaking it for a corpse would unlink a live one.
    return isRecord(error) && error['code'] === 'EPERM'
  }
}

/**
 * A live entry needs both halves: the process that owns it and the socket it
 * serves. Either half missing means the entry is stale.
 * @param entry - the entry to test.
 * @returns true when the process exists and its socket file does.
 */
export function isEntryLive(entry: RegistryEntry): boolean {
  return isAlive(entry.pid) && existsSync(entry.socket)
}

/**
 * Read every registry entry in a directory.
 * @param dir - the supervision directory.
 * @returns the valid entries, in directory order; an absent directory is empty.
 */
export function readRegistry(dir: string): readonly RegistryEntry[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const entries: RegistryEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (isRegistryEntry(parsed)) entries.push(parsed)
    } catch {
      // A concurrent writer is mid-rename or the file is corrupt. Skipping it
      // keeps the healthy entries visible; the next scan reclaims the bad one.
      continue
    }
  }
  return entries
}

/**
 * Remove entries whose process is gone or whose socket is missing, together
 * with their files. An entry is only worth keeping when both halves are live.
 * @param dir - the supervision directory.
 * @returns the pids whose entries were removed.
 */
export function reclaimStale(dir: string): readonly number[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const removed: number[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // Unparseable: nothing can prove it alive, so it is stale by definition.
      unlinkEntry(path, dir, name)
      continue
    }
    if (isRegistryEntry(parsed)) {
      if (isEntryLive(parsed)) continue
      removed.push(parsed.pid)
    }
    unlinkEntry(path, dir, name)
  }
  return removed
}

function unlinkEntry(path: string, dir: string, name: string): void {
  rmSync(path, { force: true })
  rmSync(join(dir, name.replace(/\.json$/, '.sock')), { force: true })
}

/**
 * Write one registry entry with `0600`.
 * @param paths - the entry's two paths.
 * @param entry - the entry to write.
 */
export function writeRegistry(paths: RegistryPaths, entry: RegistryEntry): void {
  writeFileSync(paths.json, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  // writeFileSync's mode is masked by the umask; the socket is the trust boundary.
  chmodSync(paths.json, 0o600)
}
