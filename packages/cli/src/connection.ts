import type { Socket } from 'node:net';
import { connect as netConnect } from 'node:net';
import {
  ProtocolError,
  decodeChunk,
  encodeFrame,
  type InFrame,
  type HelloFrame,
  type OutFrame,
} from 'dsh-supervision-protocol';

/** How long the first reply may take before the backend counts as unreachable (ADR: 5 s). */
export const REPLY_TIMEOUT_MS = 5000;

/** Root record `msg` when the bridge is gone, exactly as the ADR spells it. */
export const BACKEND_OFFLINE = 'backend offline';

/** Root record `msg` when `welcome` never arrived. */
export const HANDSHAKE_TIMEOUT = 'backend handshake timeout';

export interface ConnectionHandlers {
  /** Called for every validated frame, in arrival order. */
  onFrame(frame: OutFrame): void;
  /**
   * The socket ended, failed, timed out, or broke the protocol. `msg` is the
   * root record text; `detail` carries the underlying cause for stderr.
   */
  onLost(msg: string, detail: string): void;
  /**
   * `encodeFrame` refused a frame before it reached the socket. Nothing was
   * written and the backend is untouched, so this is a local refusal, never a
   * lost backend. `detail` is the encoder's own reason.
   */
  onRefused(detail: string): void;
}

export interface Connection {
  /** Encodes and writes one frame; a refused frame goes to `onRefused`. */
  send(frame: InFrame): void;
  /** Ends the socket; the peer sees EOF. */
  close(): void;
}

/**
 * Connects and holds the one reply the caller needs to `REPLY_TIMEOUT_MS`:
 * `welcome` for a bridge, `sessions` for a list. `hello` is omitted by `list`,
 * which binds no bridge. The codec lives in `dsh-supervision/protocol`; this
 * module owns only the socket and the deadline.
 */
export function connect(
  socketPath: string,
  hello: HelloFrame | undefined,
  handlers: ConnectionHandlers,
): Connection {
  const socket: Socket = netConnect(socketPath);
  socket.setEncoding('utf8');

  let settled = false;
  let rest = '';
  const deadline = setTimeout(() => {
    socket.destroy();
    finish(HANDSHAKE_TIMEOUT, hello === undefined ? 'no reply to list' : `no welcome within ${String(REPLY_TIMEOUT_MS)} ms`);
  }, REPLY_TIMEOUT_MS);

  function finish(msg: string, detail: string): void {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    handlers.onLost(msg, detail);
  }

  /**
   * Every outbound frame takes the one encoder, so `MAX_FRAME` governs both
   * halves. A refusal is reported, not escalated: the socket and the bridge
   * stay up, and the caller decides what a refused frame means for it.
   */
  function write(frame: InFrame): void {
    let line: string;
    try {
      line = encodeFrame(frame);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      handlers.onRefused(error.message);
      return;
    }
    socket.write(line);
  }

  socket.on('connect', () => {
    if (hello !== undefined) write(hello);
  });
  socket.on('error', (error: Error) => finish(BACKEND_OFFLINE, error.message));
  socket.on('close', () => finish(BACKEND_OFFLINE, 'socket closed'));

  socket.on('data', (chunk: string) => {
    const decoded = decodeChunk(rest, chunk);
    if (!decoded.ok) {
      socket.destroy();
      finish(BACKEND_OFFLINE, decoded.reason);
      return;
    }
    rest = decoded.rest;
    for (const frame of decoded.frames) {
      if (settled) return;
      // The deadline covers the first reply only; a live bridge outlives it.
      if (frame.t === 'welcome' || frame.t === 'sessions') clearTimeout(deadline);
      handlers.onFrame(frame);
    }
  });

  return {
    send(frame: InFrame): void {
      if (settled || socket.destroyed) return;
      write(frame);
    },
    close(): void {
      settled = true;
      clearTimeout(deadline);
      socket.end();
    },
  };
}
