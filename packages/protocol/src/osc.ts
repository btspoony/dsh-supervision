/**
 * OSC 7501 encoder. herdr-core replaces a status record with each report, so a
 * report that cannot be expressed within the caps is dropped whole and never
 * truncated: half a record is worse than no record.
 */

const ESC = '\x1b'
const ST = '\x1b\\'

/** herdr-core caps one sequence below its 4 KiB frame limit. */
const MAX_SEQUENCE = 4096
/** The `state` and `app` words share one cap: neither is free text. */
const MAX_WORD = 32
const MAX_TITLE = 192
const MAX_TITLE_B64 = 256
const MAX_MSG = 2048
const MAX_MSG_B64 = 2732
const MAX_ID = 128
const MAX_ID_SEGMENT = 32
const MAX_ID_SEGMENTS = 8

const WORD = /^[A-Za-z0-9_.+-]+$/
/** C0, DEL, C1, and the bidi overrides — none may reach a terminal verbatim. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

const STATES: readonly string[] = ['idle', 'working', 'done', 'blocked', 'error']
const KINDS: readonly string[] = ['permission', 'question', 'auth']

/** Root report `app` value; the plugin's default, restated on every report. */
export const APP_NAME = 'dsh'

export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error'
export type ProgramKind = 'permission' | 'question' | 'auth'

/** Proves a decoded word is a state this protocol defines. */
export function isProgramState(value: unknown): value is ProgramState {
  return typeof value === 'string' && STATES.includes(value)
}

export interface ProgramStatus {
  readonly state: ProgramState
  /** Only meaningful on `blocked`. */
  readonly kind?: ProgramKind
  /** Only meaningful on `working` or `blocked`. */
  readonly progress?: number
  readonly app?: string
  readonly title?: string
  readonly msg?: string
  /** Child record id; absent for the root record. */
  readonly id?: string
}

/** The fields of one root record; every present field is restated on each report. */
export interface ReportFields {
  readonly state: string
  readonly app?: string
  readonly title?: string
  readonly msg?: string
}

/** One control-free line, whitespace collapsed. */
export function clean(text: string): string {
  return text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * One `:`-delimited word field, flattened like the free-text fields: anything
 * outside {@link WORD} (control bytes, the `:`/`=` separators, the sequence's
 * own ESC) is removed, then the value is capped.
 * @param text - the caller's value.
 * @param fallback - the word to report when nothing survives.
 * @returns a single control-free, delimiter-free word, or `fallback`.
 */
function fieldWord(text: string, fallback: string): string {
  const word = clean(text.replace(/[^A-Za-z0-9_.+-]+/g, ' ')).slice(0, MAX_WORD).trim()
  return word === '' ? fallback : word
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function legalId(id: string): boolean {
  if (Buffer.byteLength(id, 'utf8') > MAX_ID) return false
  const segments = id.split('/')
  if (segments.length > MAX_ID_SEGMENTS) return false
  return segments.every(segment => WORD.test(segment) && Buffer.byteLength(segment, 'utf8') <= MAX_ID_SEGMENT)
}

/**
 * Encode one legal report, or `''` when the record cannot be expressed.
 * @param record - the report's fields; every cap is enforced here.
 * @returns the complete `ESC ] 7501 ; … ST` sequence, or `''`.
 */
export function programStatus(record: ProgramStatus): string {
  const { state } = record
  if (!STATES.includes(state)) return ''

  const fields = [`state=${state}`]

  if (record.id !== undefined && record.id !== '') {
    if (!legalId(record.id)) return ''
    fields.push(`id=${record.id}`)
  }

  if (record.kind !== undefined) {
    if (state !== 'blocked' || !KINDS.includes(record.kind)) return ''
    fields.push(`kind=${record.kind}`)
  }

  if (record.progress !== undefined) {
    const { progress } = record
    if (state !== 'working' && state !== 'blocked') return ''
    if (!Number.isInteger(progress) || progress < 0 || progress > 100) return ''
    fields.push(`progress=${String(progress)}`)
  }

  if (record.app !== undefined && record.app !== '') {
    if (!WORD.test(record.app) || Buffer.byteLength(record.app, 'utf8') > MAX_WORD) return ''
    fields.push(`app=${record.app}`)
  }

  if (record.title !== undefined) {
    const title = clean(record.title)
    if (title !== '') {
      const encoded = base64(title)
      if (Buffer.byteLength(title, 'utf8') > MAX_TITLE || encoded.length > MAX_TITLE_B64) return ''
      fields.push(`title=${encoded}`)
    }
  }

  if (record.msg !== undefined) {
    const msg = clean(record.msg)
    if (msg !== '') {
      const encoded = base64(msg)
      if (Buffer.byteLength(msg, 'utf8') > MAX_MSG || encoded.length > MAX_MSG_B64) return ''
      fields.push(`msg=${encoded}`)
    }
  }

  const sequence = `${ESC}]7501;${fields.join(':')}${ST}`
  return Buffer.byteLength(sequence, 'utf8') < MAX_SEQUENCE ? sequence : ''
}

/**
 * Encode a clear: the root record, or one child record and its descendants.
 * @param id - child record id; omitted or empty clears the root.
 * @returns the sequence, or `''` for an illegal id.
 */
export function clearProgramStatus(id?: string): string {
  if (id === undefined || id === '') return `${ESC}]7501;state=clear${ST}`
  if (!legalId(id)) return ''
  return `${ESC}]7501;state=clear:id=${id}${ST}`
}

/**
 * Encode one unconditional root report. Unlike {@link programStatus} this never
 * returns `''`: an unrepresentable field is flattened and truncated, because a
 * forwarder that goes silent leaves herdr-core showing a stale record.
 *
 * Every field is flattened the same way, so no value can open, split or
 * terminate the record: control bytes and the `:`/`=` separators are removed,
 * then each field is capped.
 * @param fields - the record; `state` is not restricted to {@link ProgramState}.
 * @returns the complete `ESC ] 7501 ; … ST` sequence.
 */
export function encodeReport(fields: ReportFields): string {
  // An unencodable state must not read as success; `error` is the one word that
  // says the report itself is the problem.
  const parts = [`state=${fieldWord(fields.state, 'error')}`]
  if (fields.app !== undefined) {
    const app = fieldWord(fields.app, '')
    if (app !== '') parts.push(`app=${app}`)
  }
  if (fields.title !== undefined) parts.push(`title=${base64(clean(fields.title).slice(0, MAX_TITLE))}`)
  if (fields.msg !== undefined) parts.push(`msg=${base64(clean(fields.msg).slice(0, MAX_MSG))}`)
  return `${ESC}]7501;${parts.join(':')}${ST}`
}
