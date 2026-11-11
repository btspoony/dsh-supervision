/**
 * Process exit codes, as the ADR fixes them. `protocol` is the forwarder's own
 * refusal: the frame never reached the wire, so the backend is alive and the
 * exit must not say otherwise.
 */
export const EXIT = {
  ok: 0,
  backendLost: 1,
  usage: 2,
  busy: 3,
  locked: 4,
  createFailed: 5,
  protocol: 6,
} as const;

/**
 * Maps an `error.code` onto its exit code (ADR): the plugin's refusals and the
 * forwarder's own `protocol` refusal both keep their ADR code, so the exit
 * never claims a lost backend for a local refusal. Genuinely unknown codes
 * still mean a lost backend.
 */
export function exitCodeFor(code: string): number {
  switch (code) {
    case 'busy':
      return EXIT.busy;
    case 'locked':
      return EXIT.locked;
    case 'create-failed':
      return EXIT.createFailed;
    case 'protocol':
      return EXIT.protocol;
    default:
      return EXIT.backendLost;
  }
}
