/**
 * Fleet activity: what the fleet spent, ran and was refused over a recent
 * interval, aggregated on the server from stored telemetry. Only counts, sums
 * and agent names leave here; never payloads, tool inputs or secrets.
 *
 * Time is UTC throughout. 7 and 30 days are whole UTC days ending today; 24
 * hours is rolling, so it can touch two calendar days, and both are clipped to
 * the interval.
 */
import type { Store } from "./store"

export const FLEET_RANGES = ["24h", "7d", "30d"] as const
export type FleetRange = (typeof FLEET_RANGES)[number]
export const DEFAULT_FLEET_RANGE: FleetRange = "7d"
export const TOP_AGENTS = 5

const DAY_MS = 86_400_000

export interface FleetInterval {
  from: Date
  to: Date
  /** Every UTC day the interval touches, oldest first, as YYYY-MM-DD. */
  days: string[]
}

export function fleetInterval(range: FleetRange, now: Date): FleetInterval {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const from =
    range === "24h" ? new Date(now.getTime() - DAY_MS) : new Date(midnight - (range === "7d" ? 6 : 29) * DAY_MS)
  const days: string[] = []
  for (
    let day = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    day <= now.getTime();
    day += DAY_MS
  ) {
    days.push(new Date(day).toISOString().slice(0, 10))
  }
  return { from, to: now, days }
}

export interface AgentActivity {
  id: string
  label: string
  /** Null when the agent was active but reported no cost. */
  spend_usd: number | null
  runs: number
}

export interface FleetMetrics {
  range: FleetRange
  time_basis: "UTC"
  from: string
  to: string
  /** Null when nothing in the interval carried a cost: unknown, not zero. */
  spend_usd: number | null
  cost_coverage: { priced_reports: number; unpriced_reports: number }
  runs_started: number
  median_run_ms: number | null
  completed_runs: number
  refused_actions: number
  current: { agents_running: number; awaiting_you: number }
  agents: AgentActivity[]
  other: { agents: number; spend_usd: number | null; runs: number } | null
  daily: Array<{ date: string; spend_usd: number | null; runs: number }>
}

/** Adds costs, keeping "nothing recorded" (null) apart from a recorded zero. */
const addCost = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b)

export function fleetMetrics(store: Store, range: FleetRange, now = new Date()): FleetMetrics {
  const { from, to, days } = fleetInterval(range, now)
  const fromIso = from.toISOString()
  const toIso = to.toISOString()
  const spendRows = store.activitySpend(fromIso, toIso)
  const startRows = store.activityRunStarts(fromIso, toIso)

  const byAgent = new Map<string, AgentActivity>()
  const agent = (id: string, label: string) => {
    let entry = byAgent.get(id)
    if (!entry) byAgent.set(id, (entry = { id, label, spend_usd: null, runs: 0 }))
    return entry
  }
  // A day with no rows at all is zero recorded activity; a day whose rows
  // carried no cost stays null.
  const byDay = new Map(days.map((date) => [date, { date, spend_usd: 0 as number | null, runs: 0, seen: false }]))
  let spend: number | null = null
  for (const row of spendRows) {
    const entry = agent(row.agent_id, row.label)
    entry.spend_usd = addCost(entry.spend_usd, row.spend)
    const day = byDay.get(row.day)
    if (day) {
      day.spend_usd = day.seen ? addCost(day.spend_usd, row.spend) : row.spend
      day.seen = true
    }
    spend = addCost(spend, row.spend)
  }
  let runsStarted = 0
  for (const row of startRows) {
    agent(row.agent_id, row.label).runs += row.runs
    const day = byDay.get(row.day)
    if (day) day.runs += row.runs
    runsStarted += row.runs
  }

  const ranked = [...byAgent.values()].sort(
    (a, b) => (b.spend_usd ?? -1) - (a.spend_usd ?? -1) || b.runs - a.runs || a.label.localeCompare(b.label),
  )
  const rest = ranked.slice(TOP_AGENTS)
  const coverage = store.activityCostCoverage(fromIso, toIso)
  const median = store.medianRunDuration(fromIso, toIso)

  return {
    range,
    time_basis: "UTC",
    from: fromIso,
    to: toIso,
    spend_usd: spend,
    cost_coverage: { priced_reports: coverage.priced, unpriced_reports: coverage.unpriced },
    runs_started: runsStarted,
    median_run_ms: median.median_ms,
    completed_runs: median.completed,
    refused_actions: store.refusedActions(fromIso, toIso),
    current: { agents_running: store.agentsRunning(), awaiting_you: store.awaitingDecisions(toIso) },
    agents: ranked.slice(0, TOP_AGENTS),
    other: rest.length
      ? {
          agents: rest.length,
          spend_usd: rest.reduce<number | null>((sum, a) => addCost(sum, a.spend_usd), null),
          runs: rest.reduce((sum, a) => sum + a.runs, 0),
        }
      : null,
    daily: [...byDay.values()].map(({ date, spend_usd, runs }) => ({ date, spend_usd, runs })),
  }
}
