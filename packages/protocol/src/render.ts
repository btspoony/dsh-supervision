/**
 * The tty half of the wire: how a forwarder turns one `OutFrame` into bytes.
 * `sessions` returns `undefined` because the tty transport has no listing
 * command, and `error` is tty-only — a forwarder keeps its stderr and exit.
 *
 * A `mirror` frame is the one human-facing record: append-only transcript
 * lines, wrapped to the width the caller names and never coloured or rewritten.
 */

import { isRecord, type AskFrame, type MirrorItem, type OutFrame } from './frames.js'
import { APP_NAME, encodeReport, stripControls } from './osc.js'

/** Default wrap width when the caller has no terminal width of its own. */
const DEFAULT_WIDTH = 100

/** Argument keys worth one header line, in the order a reader wants them. */
const SUMMARY_KEYS = ['description', 'command', 'path', 'query', 'pattern'] as const

/**
 * Renders one frame for a terminal, newline included.
 * @param frame - any frame the plugin may write.
 * @param width - columns a `mirror` block wraps to; the caller's terminal width,
 *   or {@link DEFAULT_WIDTH} when it has none.
 * @returns bytes to write, or `undefined` when this transport has nothing to say.
 */
export function renderFrame(frame: OutFrame, width?: number): string | undefined {
  switch (frame.t) {
    case 'welcome':
      // `state` and `turn` are not written: hc replaces the record whole, so the
      // forwarder's own readiness record is the one it already knows.
      return `${encodeReport({ state: 'idle', app: APP_NAME, title: frame.title })}\n`
    case 'osc':
      // `osc.data` is opaque: written verbatim, never inspected or re-encoded.
      return frame.data
    case 'echo':
      return `${frame.text}\n`
    case 'mirror':
      // `renderMirror` is the pure block with no terminator; this arm adds the
      // one newline every tty record ends with, exactly like `echo` does, so a
      // following OSC record never glues onto the transcript's last line.
      return `${renderMirror(frame.item, width)}\n`
    case 'ask':
      // Same contract as `mirror`: a pure block, one terminator, no colour or
      // cursor movement, so a supervisor may append it to any transcript.
      return `${renderAsk(frame, width)}\n`
    case 'sessions':
    case 'catalog':
      // Machine surfaces: a listing belongs to the socket's list command and a
      // catalog to the interactive menu, never to the tty report stream.
      return undefined
    case 'error':
      return `${encodeReport({ state: 'error', app: APP_NAME, msg: `${frame.code}: ${frame.message}` })}\n`
    case 'bye':
      return `${encodeReport({ state: 'clear', app: APP_NAME })}\n`
  }
}

/**
 * Renders one transcript item as append-only lines: no colour, no box drawing,
 * no cursor movement, and no trailing newline.
 * @param item - the transcript item a `mirror` frame carries.
 * @param width - columns to wrap to; defaults to {@link DEFAULT_WIDTH}.
 * @returns the block's lines joined with `\n`.
 */
export function renderMirror(item: MirrorItem, width: number = DEFAULT_WIDTH): string {
  const w = Math.max(1, Math.floor(width))
  const lines: string[] = []
  // Every field below is model or host prose on the same byte stream a
  // supervisor parses, so control bytes are neutralised before any wrapping.
  // That per-field pass is not enough on its own — a JSON escape such as
  // `\u001b` inside tool arguments becomes an ESC only once parsed — so every
  // finished line is stripped again below, as the invariant.
  switch (item.k) {
    case 'user':
      // The gutter marks the first line only; every later line sits under it.
      for (const [index, source] of stripControls(item.text, '\n\t').split('\n').entries()) {
        wrap(source, w, index === 0 ? '❯ ' : '  ', '  ', lines)
      }
      trimTail(lines)
      break
    case 'assistant': {
      const reasoning = stripControls(item.reasoning ?? '', '\n\t').split('\n')[0]?.trim() ?? ''
      if (reasoning !== '') wrap(reasoning, w, '· ', '  ', lines)
      const text = stripControls(item.text ?? '', '\n\t')
      if (text.trim() !== '') for (const source of text.split('\n')) wrap(source, w, '', '', lines)
      trimTail(lines)
      if (item.interrupted === true) {
        const last = lines.length - 1
        if (last === -1) lines.push('(interrupted)')
        else lines[last] = `${lines[last] ?? ''} (interrupted)`
      }
      const { usage } = item
      if (usage !== undefined) {
        const cache = usage.cacheReadTokens
        lines.push(`⟦↑${count(usage.inputTokens)} ↓${count(usage.outputTokens)}${cache === undefined ? '' : ` R${count(cache)}`}⟧`)
      }
      break
    }
    case 'tool': {
      const glyph = item.state === 'start' ? '⏳' : item.state === 'ok' ? '✔' : '✘'
      const summary = summarize(stripControls(item.args, '\n\t'))
      const name = stripControls(item.name)
      const head = summary === '' ? name : `${name}: ${summary}`
      const meta = item.state !== 'start' && item.ms !== undefined ? ` ⟦${String(item.ms)}ms⟧` : ''
      wrap(`${glyph} ${head}${meta}`, w, '', '  ', lines)
      const detail = stripControls(item.detail ?? '', '\n\t').split('\n')[0]?.trim() ?? ''
      if (detail !== '') wrap(detail, w, '  └─ ', '     ', lines)
      trimTail(lines)
      break
    }
  }
  // The invariant, whatever produced a line: nothing a terminal executes or
  // reverses ever leaves this function. A new field or helper is covered here
  // without touching this line.
  return lines.map(line => stripControls(line, '\t')).join('\n')
}

/**
 * Drops trailing blank lines, so a source that ends with `\n` cannot leave the
 * block newline-terminated. Interior blank lines are kept.
 */
function trimTail(lines: string[]): void {
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
}

/**
 * Renders one pending agent question as an append-only block: a header naming
 * the ask, each question with its options numbered from 1, and the usage line
 * the answer grammar expects. A closed ask is a single line, so the surface that
 * saw the card can retire it. No colour, no cursor movement, no trailing newline.
 * @param frame - the ask frame to render, open or closed.
 * @param width - columns to wrap to; defaults to {@link DEFAULT_WIDTH}.
 * @returns the block's lines joined with `\n`.
 */
export function renderAsk(frame: AskFrame, width: number = DEFAULT_WIDTH): string {
  if ('closed' in frame) return stripControls(`(question ${frame.id} closed)`, '\t')
  const w = Math.max(1, Math.floor(width))
  const lines: string[] = []
  const count = frame.questions.length
  wrapLines(`ask ${frame.id} · ${String(count)} ${count === 1 ? 'question' : 'questions'}`, w, '', '', lines)
  for (const question of frame.questions) {
    // The id stays on the question line: an answer token names it, and a person
    // reading the card needs that token without opening the manual.
    const header = question.header === undefined ? '' : `${question.header}: `
    const multi = question.multiSelect === true ? ' (multi-select)' : ''
    wrapLines(`[${question.id}] ${header}${question.question}${multi}`, w, '', '  ', lines)
    for (const [index, option] of (question.options ?? []).entries()) {
      const text = option.description === undefined ? option.label : `${option.label} — ${option.description}`
      wrapLines(`${String(index + 1)}. ${text}`, w, '  ', '    ', lines)
    }
  }
  // The grammar is restated per ask id: one token per question, so a multi-question
  // card shows every question id its answer has to name.
  const spec = count === 1
    ? '<n[,n]|text|->'
    : frame.questions.map(question => `${question.id}=<n[,n]|text|->`).join(' ')
  wrapLines(`answer: /answer ${frame.id} ${spec}`, w, '', '', lines)
  trimTail(lines)
  return lines.map(line => stripControls(line, '\t')).join('\n')
}

/**
 * Wraps every source line of one field separately, so a newline a caller carried
 * becomes a line break instead of one long line with a collapsed space.
 * @param source - the field text, newlines included.
 * @param width - columns to wrap to.
 * @param first - prefix for the first line of each source line.
 * @param rest - prefix for a wrapped continuation.
 * @param into - the block being built.
 */
function wrapLines(source: string, width: number, first: string, rest: string, into: string[]): void {
  for (const line of source.split(/\r\n|\r|\n/)) wrap(line, width, first, rest, into)
}

/**
 * Appends `source` to `into`, word-wrapped to `width`; the first line of this
 * call takes `first`, its continuation lines and any later line `rest`.
 * shortcut: width counts UTF-16 units and runs of spaces collapse, so a block
 * needing east-asian width or alignment fidelity would need a real wcwidth wrap.
 */
function wrap(source: string, width: number, first: string, rest: string, into: string[]): void {
  let line = first
  const words = source.trim().split(/\s+/u).filter((word) => word !== '')
  if (words.length === 0) {
    into.push(line.trimEnd())
    return
  }
  for (const [index, word] of words.entries()) {
    if (index > 0 && line.length + 1 + word.length > width) {
      into.push(line)
      line = `${rest}${word}`
      continue
    }
    line = index === 0 ? `${line}${word}` : `${line} ${word}`
  }
  into.push(line)
}

/** The first useful argument a tool call carries, or the head of the raw args. */
function summarize(args: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    parsed = undefined
  }
  if (isRecord(parsed)) {
    for (const key of SUMMARY_KEYS) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim() !== '') return value.split('\n')[0]?.trim() ?? ''
    }
  }
  return args.split('\n')[0]?.trim() ?? ''
}

/** Thousands separated, so a large step reads at a glance. */
function count(value: number): string {
  return value.toLocaleString('en-US')
}
