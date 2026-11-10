/**
 * The shared control protocol: OSC 7501 reports, NDJSON frames and the
 * supervision registry. Both the plugin and `dsh-sup` import from here, so one
 * definition governs both halves of the wire.
 */

export * from './osc.js'
export * from './frames.js'
export * from './registry.js'
