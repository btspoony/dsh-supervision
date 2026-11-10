import { parseArgs, usageText } from './args.js';
import { connect, type Connection } from './connection.js';
import { isLive, liveEntries, readEntries, resolveSocketDir, selectEntry, type RegistryEntry } from './registry.js';
import { splitLines } from './lines.js';
import { openTty } from './tty.js';
import { APP_NAME, encodeReport, type HelloFrame, type ServerFrame, type SessionItem } from './wire.js';

/** Process exit codes, as the ADR fixes them. */
const EXIT = {
  ok: 0,
  backendLost: 1,
  usage: 2,
  busy: 3,
  locked: 4,
  createFailed: 5,
} as const;

const HEADER = ['SESSION', 'CWD', 'LIVE', 'BRIDGED'].join('\t');

/** Maps a plugin `error.code` onto its exit code (ADR); anything else is a lost backend. */
function exitCodeFor(code: string): number {
  switch (code) {
    case 'busy':
      return EXIT.busy;
    case 'locked':
      return EXIT.locked;
    case 'create-failed':
      return EXIT.createFailed;
    default:
      return EXIT.backendLost;
  }
}

/** A root record restates `app`, because hc replaces the record whole. */
function rootReport(state: string, extra: { readonly title?: string; readonly msg?: string } = {}): string {
  return `${encodeReport({ state, app: APP_NAME, ...extra })}\n`;
}

/** Prints a refusal plus the backends it considered; the caller exits 2. */
function refuse(reason: string, entries: readonly RegistryEntry[]): void {
  const candidates = entries.map((entry) => `  pid ${String(entry.pid)}  ${entry.socket}`);
  process.stderr.write(`${[reason, ...candidates].join('\n')}\n`);
}

/**
 * Resolves the live backends, then runs `list` or binds a bridge. `list`
 * spans every entry because it enumerates; a bridge needs exactly one, so a
 * second one is a refusal that names the candidates.
 */
async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv, process.cwd());
  if (parsed.kind === 'usage') {
    process.stderr.write(`${parsed.reason}\n${usageText}\n`);
    return EXIT.usage;
  }

  const entries = readEntries(resolveSocketDir(process.env));
  const live = liveEntries(entries, isLive, parsed.pid);
  const none =
    parsed.pid === undefined
      ? 'no running dsh web found; start one, or pass --pid'
      : `no running dsh web with pid ${String(parsed.pid)}`;

  if (parsed.kind === 'list') {
    if (live.length === 0) {
      refuse(none, live);
      return EXIT.usage;
    }
    return runList(live, parsed.cwd);
  }

  const selection = selectEntry(entries, isLive, parsed.pid);
  if ('error' in selection) {
    refuse(
      selection.error === 'none'
        ? none
        : 'multiple dsh web processes are running; choose one with --pid',
      selection.entries,
    );
    return EXIT.usage;
  }

  const hello: HelloFrame =
    parsed.kind === 'attach'
      ? { t: 'hello', proto: 1, pid: process.pid, attach: parsed.session }
      : { t: 'hello', proto: 1, pid: process.pid, new: { cwd: parsed.cwd } };
  return runBridge(selection.entry.socket, hello);
}

/** Asks one backend for its sessions; a dead backend contributes nothing. */
function listFrom(socket: string, cwd: string): Promise<readonly SessionItem[]> {
  return new Promise((resolve) => {
    let connection: Connection | undefined;
    const settle = (items: readonly SessionItem[]): void => {
      connection?.close();
      resolve(items);
    };
    connection = connect(socket, undefined, {
      onFrame: (frame: ServerFrame) => {
        if (frame.t === 'sessions') settle(frame.items);
        if (frame.t === 'bye') settle([]);
        if (frame.t === 'error') {
          process.stderr.write(`${frame.code}: ${frame.message}\n`);
          settle([]);
        }
      },
      onLost: (_msg, detail) => {
        process.stderr.write(`${detail}\n`);
        settle([]);
      },
    });
    connection.send({ t: 'list', cwd });
  });
}

/**
 * Prints the union of every live backend's sessions and exits 0 without binding
 * a bridge, which is why a listing needs no welcome and takes no session.
 */
async function runList(entries: readonly RegistryEntry[], cwd: string): Promise<number> {
  const items = await Promise.all(entries.map((entry) => listFrom(entry.socket, cwd)));
  const rows = items.flat().map(
    (item) => `${item.id}\t${item.cwd}\t${item.live ? 'yes' : 'no'}\t${item.bridged ? 'yes' : '-'}`,
  );
  process.stdout.write(`${[HEADER, ...rows].join('\n')}\n`);
  return EXIT.ok;
}

/**
 * Binds one session: the root `idle` goes out the moment `welcome` lands, before
 * any stdin is read, which is what makes hc's readiness gate and `started: true`
 * work. Then both directions relay until `bye`, an error, or a lost socket.
 */
function runBridge(socket: string, hello: HelloFrame): Promise<number> {
  const tty = openTty();
  if (!tty.ok) {
    process.stderr.write(`${tty.error}\n`);
    return Promise.resolve(EXIT.backendLost);
  }

  let rest = '';
  let settled = false;
  /** Kept so the closing error record can restate `title`, which hc replaces. */
  let title = '';

  return new Promise((resolve) => {
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      process.stdin.pause();
      connection.close();
      tty.close();
      resolve(code);
    };

    const connection: Connection = connect(socket, hello, {
      onFrame: (frame: ServerFrame) => {
        if (frame.t === 'welcome') {
          title = frame.title;
          tty.write(rootReport('idle', { title }));
          pump((text) => connection.send({ t: 'line', text }));
          return;
        }
        // `osc.data` is opaque: written verbatim, never inspected or re-encoded.
        if (frame.t === 'osc') tty.write(frame.data);
        if (frame.t === 'echo') tty.write(`${frame.text}\n`);
        if (frame.t === 'error') {
          process.stderr.write(`${frame.code}: ${frame.message}\n`);
          settle(exitCodeFor(frame.code));
        }
        if (frame.t === 'bye') {
          tty.write(rootReport('clear'));
          settle(EXIT.ok);
        }
      },
      // The error record must precede the exit so hc never reports a stale
      // `working` after the backend is gone; the cause goes to stderr.
      onLost: (msg, detail) => {
        // `title` is empty only when the handshake never completed; then the
        // record simply omits it rather than reporting a blank title.
        tty.write(rootReport('error', title === '' ? { msg } : { title, msg }));
        process.stderr.write(`${detail}\n`);
        settle(EXIT.backendLost);
      },
    });

    /** Forwards stdin lines; CR and LF both terminate, and 2004 is never enabled. */
    function pump(forward: (text: string) => void): void {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        const split = splitLines(rest, chunk);
        rest = split.rest;
        for (const line of split.lines) if (line !== '') forward(line);
      });
      process.stdin.resume();
    }
  });
}

process.exitCode = await main(process.argv.slice(2));
