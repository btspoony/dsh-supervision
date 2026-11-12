import { resolve } from 'node:path';

export type Parsed =
  | { readonly kind: 'new'; readonly cwd: string; readonly pid?: number }
  | { readonly kind: 'attach'; readonly session: string; readonly pid?: number }
  | { readonly kind: 'list'; readonly cwd?: string; readonly pid?: number }
  | { readonly kind: 'usage'; readonly reason: string };

export const usageText = [
  'usage: dsh-sup [new] [--cwd <path>] [--pid <n>]',
  '       dsh-sup attach <session-id> [--pid <n>]',
  '       dsh-sup <session-id> [--pid <n>]',
  '       dsh-sup list [--pid <n>] [--cwd <path>]   (every session; --cwd filters)',
].join('\n');

/**
 * Parses the forwarder grammar into a discriminated result. `base` is the
 * directory `--cwd` resolves against, passed in so this stays free of `process`.
 */
export function parseArgs(argv: readonly string[], base: string): Parsed {
  const words: string[] = [];
  let cwd: string | undefined;
  let pid: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg !== '--pid' && arg !== '--cwd') {
      if (arg.startsWith('-')) return { kind: 'usage', reason: `unknown option ${arg}` };
      words.push(arg);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) return { kind: 'usage', reason: `${arg} needs a value` };
    i++;
    if (arg === '--cwd') {
      cwd = resolve(base, value);
      continue;
    }
    if (!/^[1-9]\d*$/.test(value)) {
      return { kind: 'usage', reason: `--pid needs a positive integer, got ${value}` };
    }
    pid = Number(value);
  }

  const [command, ...rest] = words;
  const target = cwd ?? resolve(base);

  if (command === undefined || command === 'new') {
    if (rest.length > 0) return { kind: 'usage', reason: `unexpected argument ${rest[0]}` };
    return pid === undefined ? { kind: 'new', cwd: target } : { kind: 'new', cwd: target, pid };
  }

  if (command === 'list') {
    if (rest.length > 0) return { kind: 'usage', reason: `unexpected argument ${rest[0]}` };
    // No `--cwd` lists every session: the table's own CWD column says where
    // each one lives, and filtering by the caller's directory hides the rest.
    return {
      kind: 'list',
      ...(cwd === undefined ? {} : { cwd }),
      ...(pid === undefined ? {} : { pid }),
    };
  }

  if (command === 'attach' || command.startsWith('session-')) {
    const session = command === 'attach' ? rest[0] : command;
    if (command === 'attach' && rest.length !== 1) {
      return { kind: 'usage', reason: 'attach needs exactly one session id' };
    }
    if (session === undefined || !session.startsWith('session-') || session.length === 'session-'.length) {
      return { kind: 'usage', reason: `not a session id: ${session ?? ''}` };
    }
    if (cwd !== undefined) return { kind: 'usage', reason: '--cwd applies to new and list only' };
    return pid === undefined
      ? { kind: 'attach', session }
      : { kind: 'attach', session, pid };
  }

  return { kind: 'usage', reason: `unknown command ${command}` };
}
