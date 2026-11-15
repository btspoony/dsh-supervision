/**
 * What a bridged session is still doing, apart from its own turn: the subagents
 * it spawned and the background jobs it owns. Pure over a host-shaped snapshot —
 * no clock, no I/O, no host package — so the aggregation is tested without a DSH.
 */

/** One active child of the root: the id the supervisor can print, plus its label. */
export interface ActivityItem {
  readonly id: string
  readonly label?: string
}

/** The two non-turn families that can keep the root busy. */
export interface Activity {
  readonly subagents: readonly ActivityItem[]
  readonly jobs: readonly ActivityItem[]
}

/** One agent as the host lists it; absent lineage fields mean "not a descendant". */
export interface AgentActivityView {
  readonly sessionId: string
  readonly parentSession?: string
  readonly origin?: string
  readonly status: 'idle' | 'running'
}

/** One background job as the host lists it; only its owner and status matter. */
export interface JobActivityView {
  readonly id: string
  readonly label?: string
  readonly owner?: string
  readonly status: string
}

/** The host snapshot the aggregator reads, in the order each list came back. */
export interface HostActivityInput {
  readonly agents: readonly AgentActivityView[]
  readonly jobs: readonly JobActivityView[]
}

/**
 * How long an activity family may sit unchanged before the root stops trusting
 * it. A child that never settles must not report `working` forever.
 */
export const ACTIVITY_STALE_MS = 5 * 60_000

/**
 * The active families of one root session.
 * @param rootSession - the bridged session every descendant is measured against.
 * @param input - the host's current agents and jobs.
 * @returns running subagent descendants and owned running/stopping jobs, each
 *   in the order the host listed them.
 */
export function activityOf(rootSession: string, input: HostActivityInput): Activity {
  const byId = new Map(input.agents.map(agent => [agent.sessionId, agent]))
  // Walking each lineage to the root would repeat the same chain for every
  // descendant, so one visited set per walk keeps a looping log linear and safe.
  const descendsFromRoot = (view: AgentActivityView): boolean => {
    const seen = new Set<string>()
    let parent = view.parentSession
    while (parent !== undefined && !seen.has(parent)) {
      if (parent === rootSession) return true
      seen.add(parent)
      parent = byId.get(parent)?.parentSession
    }
    return false
  }
  const subagents: ActivityItem[] = []
  for (const agent of input.agents) {
    // A fork inherits the parent but is its own conversation, not work for this
    // root, so the host's own origin marker decides; lineage alone is too broad.
    if (agent.sessionId === rootSession || agent.origin !== 'subagent') continue
    if (agent.status !== 'running' || !descendsFromRoot(agent)) continue
    subagents.push({ id: agent.sessionId })
  }
  const jobs: ActivityItem[] = []
  for (const job of input.jobs) {
    // The host's status vocabulary owns what "active" means for a job; the
    // plugin only names the root's own jobs and never guesses a state.
    if (job.owner !== rootSession || (job.status !== 'running' && job.status !== 'stopping')) continue
    jobs.push(job.label === undefined ? { id: job.id } : { id: job.id, label: job.label })
  }
  return { subagents, jobs }
}

/**
 * The root report's activity half: whether any family is busy, and why.
 * @param activity - the aggregated families.
 * @returns `working` and the short summary the root `msg` carries; empty when idle.
 */
export function activitySummary(activity: Activity): { readonly working: boolean; readonly msg: string } {
  const parts: string[] = []
  const { subagents, jobs } = activity
  if (subagents.length > 0) parts.push(`${String(subagents.length)} subagent${subagents.length === 1 ? '' : 's'}`)
  if (jobs.length > 0) parts.push(`${String(jobs.length)} job${jobs.length === 1 ? '' : 's'}`)
  return { working: parts.length > 0, msg: parts.join(' · ') }
}

/**
 * Whether an activity family has gone unchanged for longer than its window.
 * @param lastChange - epoch milliseconds of the last observed change.
 * @param now - the caller's epoch milliseconds; the clock is never read here.
 * @returns true when the family is older than {@link ACTIVITY_STALE_MS}.
 */
export function staleActivity(lastChange: number, now: number): boolean {
  return now - lastChange > ACTIVITY_STALE_MS
}
