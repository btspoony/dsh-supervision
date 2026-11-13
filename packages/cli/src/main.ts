import { parseArgs, usageText } from './args.js';
import { connect, type Connection } from './connection.js';
import { EXIT, exitCodeFor } from './exit.js';
import { runList } from './list.js';
import { liveEntries, selectEntry } from './registry.js';
import { lineForwarder } from './lines.js';
import { routeFrame } from './route.js';
import { skillText, version } from './skill.js';
import { openTty } from './tty.js';
import { APP_NAME, PROTO, encodeReport, isEntryLive, readRegistry, supervisionDir } from 'dsh-supervision-protocol';
import type { HelloFrame, OutFrame, RegistryEntry } from 'dsh-supervision-protocol';

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

  // Informational output: answered before the registry, so it works with no live dsh web.
  if (parsed.kind === 'version' || parsed.kind === 'skill') {
    process.stdout.write(parsed.kind === 'version' ? `${version()}\n` : skillText());
    return EXIT.ok;
  }

  const entries = readRegistry(supervisionDir(process.env));
  const live = liveEntries(entries, isEntryLive, parsed.pid);
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

  const selection = selectEntry(entries, isEntryLive, parsed.pid);
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
      ? { t: 'hello', proto: PROTO, pid: process.pid, attach: parsed.session }
      : { t: 'hello', proto: PROTO, pid: process.pid, new: { cwd: parsed.cwd } };
  return runBridge(selection.entry.socket, hello);
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

    /**
     * Bytes of the line currently being sent, so a local refusal can name the
     * input the user actually submitted rather than the encoder's frame cap.
     */
    let sending = 0;

    /** Sends one line; a frame this process refused ends the bridge without blaming the backend. */
    const sendLine = (text: string): void => {
      sending = Buffer.byteLength(text, 'utf8');
      connection.send({ t: 'line', text });
    };

    const connection: Connection = connect(socket, hello, {
      onFrame: (frame: OutFrame) => {
        // The `error` arm is tty-only: its cause belongs on stderr and its code
        // decides the exit, so it never goes through the shared renderer.
        if (frame.t === 'error') {
          process.stderr.write(`${frame.code}: ${frame.message}\n`);
          settle(exitCodeFor(frame.code));
          return;
        }
        const routed = routeFrame(frame, process.stdout.isTTY === true);
        if (routed.tty !== undefined) tty.write(routed.tty);
        // The human sink is stdout itself, never the tty writer: a redirected
        // stdout must stay free of the machine surface.
        if (routed.out !== undefined) process.stdout.write(routed.out);
        // The root `idle` must precede any stdin read, which is what makes hc's
        // readiness gate and `started: true` work.
        if (frame.t === 'welcome') {
          title = frame.title;
          pump(sendLine);
          return;
        }
        if (frame.t === 'bye') settle(EXIT.ok);
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
      // A refused frame never reached the socket, so the backend is alive and
      // the honest cause is the input, not a lost bridge.
      onRefused: (detail) => {
        const msg = sending === 0 ? detail : `input line of ${String(sending)} bytes was not sent: ${detail}`;
        process.stderr.write(`${msg}\n`);
        tty.write(rootReport('error', title === '' ? { msg } : { title, msg }));
        settle(EXIT.protocol);
      },
    });

    /** Forwards stdin lines; CR and LF both terminate, and 2004 is never enabled. */
    function pump(forward: (text: string) => void): void {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', lineForwarder(forward));
      process.stdin.resume();
    }
  });
}

process.exitCode = await main(process.argv.slice(2));
