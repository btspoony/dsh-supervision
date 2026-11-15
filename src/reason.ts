/**
 * The one-line reason for a thrown value. Shared because every caller that
 * degrades instead of failing prints it to a human.
 */

/**
 * @param error - the thrown value.
 * @returns its message, for a refusal the forwarder prints verbatim.
 */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
