/**
 * The surface's colour vocabulary: one small token table rendered through
 * pi-tui's own ANSI helpers (256-colour indexes, no chalk). Plain mode is the
 * same API with every function an identity, which is what `NO_COLOR`, a
 * redirected stdout or `TERM=dumb` select — so machine output stays byte-clean.
 */

import {
  indexedColor,
  styleText,
  type MarkdownTheme,
  type TextStyle,
} from '@earendil-works/pi-tui';

/** Every colour role the transcript, status bar and editor use. */
export type Token =
  | 'accent'
  | 'success'
  | 'error'
  | 'warning'
  | 'muted'
  | 'dim'
  | 'userFg'
  | 'userBg'
  | 'toolBgPending'
  | 'toolBgOk'
  | 'toolBgError'
  | 'mdHeading'
  | 'mdCode'
  | 'mdCodeBlock'
  | 'mdCodeBlockBorder'
  | 'mdQuote'
  | 'mdListBullet';

/** A token's ink: a 256-colour index and the attributes it carries. */
interface Ink {
  readonly fg?: number;
  readonly bg?: number;
  readonly bold?: boolean;
}

const INK: Record<Token, Ink> = {
  accent: { fg: 39 },
  success: { fg: 40 },
  error: { fg: 203 },
  warning: { fg: 214 },
  muted: { fg: 245 },
  dim: { fg: 240 },
  userFg: { fg: 252 },
  userBg: { bg: 236 },
  toolBgPending: { bg: 58 },
  toolBgOk: { bg: 22 },
  toolBgError: { bg: 52 },
  mdHeading: { fg: 39, bold: true },
  mdCode: { fg: 73 },
  mdCodeBlock: { fg: 250 },
  mdCodeBlockBorder: { fg: 240 },
  mdQuote: { fg: 245 },
  mdListBullet: { fg: 39 },
};

/** 256-colour is the floor every terminal this CLI supports can render. */
const MODE = '256color';

export interface Theme {
  /** False when every function below is the identity. */
  readonly color: boolean;
  /** Foreground plus the token's attributes. */
  fg(token: Token, text: string): string;
  /** Background only, for blocks that keep their own foreground. */
  bg(token: Token, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  /** The status bar: reverse video, or plain text without colour. */
  bar(text: string): string;
}

function paint(ink: Ink, text: string, backgroundOnly = false): string {
  const options: TextStyle = {
    ...(backgroundOnly || ink.fg === undefined ? {} : { fg: indexedColor(ink.fg) }),
    ...(ink.bg === undefined ? {} : { bg: indexedColor(ink.bg) }),
    ...(!backgroundOnly && ink.bold === true ? { bold: true } : {}),
  };
  return styleText(text, options, MODE);
}

const identity = (text: string): string => text;

/**
 * Builds the theme for one surface.
 * @param options - `color: false` returns identity functions, so no escape
 *   sequence can reach a captured or redirected stream.
 */
export function createTheme(options: { readonly color: boolean }): Theme {
  if (!options.color) {
    return { color: false, fg: (_token, text) => text, bg: (_token, text) => text, bold: identity, dim: identity, bar: identity };
  }
  return {
    color: true,
    fg: (token, text) => paint(INK[token], text),
    bg: (token, text) => paint(INK[token], text, true),
    bold: (text) => styleText(text, { bold: true }, MODE),
    dim: (text) => styleText(text, { dim: true }, MODE),
    bar: (text) => styleText(text, { inverse: true }, MODE),
  };
}

/** The plain theme, for callers that have no surface (and for tests). */
export const PLAIN: Theme = createTheme({ color: false });

/**
 * Colour is on only when nothing asks for it off and the sink can render it.
 * @param input - the environment and whether stdout is a terminal.
 */
export function colorEnabled(input: {
  readonly noColor: string | undefined;
  readonly stdoutTTY: boolean;
  readonly term: string | undefined;
}): boolean {
  return input.noColor === undefined && input.stdoutTTY && input.term !== 'dumb';
}

/**
 * The theme this process should draw with.
 * @param env - process environment; `NO_COLOR` present at all disables colour.
 * @param stdoutTTY - whether stdout is a terminal.
 */
export function themeFor(
  env: NodeJS.ProcessEnv = process.env,
  stdoutTTY: boolean = process.stdout.isTTY === true,
): Theme {
  return createTheme({
    color: colorEnabled({ noColor: env['NO_COLOR'], stdoutTTY, term: env['TERM'] }),
  });
}

/**
 * The markdown roles mapped onto the token table. Passing these to pi-tui's
 * `Markdown` is what makes headings, code, quotes and bullets readable as
 * structure rather than prose.
 * @param theme - the surface's theme.
 */
export function markdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg('mdHeading', text),
    link: (text) => theme.fg('mdCode', text),
    linkUrl: (text) => theme.dim(text),
    code: (text) => theme.fg('mdCode', text),
    codeBlock: (text) => theme.fg('mdCodeBlock', text),
    codeBlockBorder: (text) => theme.fg('mdCodeBlockBorder', text),
    quote: (text) => theme.fg('mdQuote', text),
    quoteBorder: (text) => theme.fg('mdCodeBlockBorder', text),
    hr: (text) => theme.dim(text),
    listBullet: (text) => theme.fg('mdListBullet', text),
    bold: (text) => theme.bold(text),
    italic: identity,
    strikethrough: identity,
    underline: identity,
  };
}
