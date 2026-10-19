import { afterEach, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import fs from "fs"
import os from "os"
import path from "path"
import { openDatabase } from "../src/db"
import { fleetInterval, fleetMetrics } from "../src/metrics"
import { Store } from "../src/store"

const NOW = new Date("2030-03-10T15:00:00.000Z")

const opened: Array<{ db: Database; dir: string }> = []
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** A fresh database per test, so other suites' rows cannot leak into the counts. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-metrics-"))
  const db = openDatabase(path.join(dir, "control.db"))
  opened.push({ db, dir })
  const store = new Store(db)
  let n = 0
  const agent = (label: string) =>
    store.createAgent(
      {
        label,
        os_shell: "linux_bash",
        location_label: null,
        task: "t",
        model_provider: "anthropic",
        model_name: "m",
        llm_api_key_sealed: null,
        interactive: false,
        permission_mode: "strict",
        permission_request_timeout_seconds: 900,
        declared_env_vars: [],
      },
      [],
      [],
    )
  const run = (agentId: string, started: string | null, ended: string | null = null, status = "succeeded") => {
    const id = `run-${++n}`
    db.query("INSERT INTO runs (id, agent_id, status, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      agentId,
      status,
      started,
      ended,
      started ?? NOW.toISOString(),
    )
    return id
  }
  const event = (runId: string, createdAt: string, cost: number | null, type = "step", tokens = 0) =>
    db
      .query(
        "INSERT INTO events (id, run_id, event_type, payload, tokens_in, tokens_out, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(`ev-${++n}`, runId, type, '{"message":"TRANSCRIPT-MARKER"}', tokens, tokens, cost, createdAt)
  const request = (runId: string, agentId: string, status: string, expiresAt: string) =>
    db
      .query(
        `INSERT INTO permission_requests (id, run_id, agent_id, engine_request_id, permission, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'read', ?, ?, ?)`,
      )
      .run(`req-${++n}`, runId, agentId, `engine-${n}`, status, expiresAt, NOW.toISOString())
  return { store, agent, run, event, request }
}

describe("fleet metric intervals", () => {
  test("ranges use explicit UTC boundaries; rolling 24 hours spans two calendar days", () => {
    const day = fleetInterval("24h", NOW)
    expect(day.from.toISOString()).toBe("2030-03-09T15:00:00.000Z")
    expect(day.days).toEqual(["2030-03-09", "2030-03-10"])
    const week = fleetInterval("7d", NOW)
    expect(week.from.toISOString()).toBe("2030-03-04T00:00:00.000Z")
    expect(week.days).toEqual([
      "2030-03-04",
      "2030-03-05",
      "2030-03-06",
      "2030-03-07",
      "2030-03-08",
      "2030-03-09",
      "2030-03-10",
    ])
    const month = fleetInterval("30d", NOW)
    expect(month.days.length).toBe(30)
    expect(month.days[0]).toBe("2030-02-09")
  })

  test("events on either side of a boundary and of midnight land in the right bucket", () => {
    const f = fixture()
    const a = f.agent("edge")
    const r = f.run(a, "2030-03-01T00:00:00.000Z")
    f.event(r, "2030-03-09T14:59:59.999Z", 100) // just before the rolling 24 hours
    f.event(r, "2030-03-09T15:00:00.000Z", 1) // the first instant inside it
    f.event(r, "2030-03-09T23:59:59.999Z", 2) // last instant of the first day
    f.event(r, "2030-03-10T00:00:00.000Z", 4) // midnight belongs to the new day
    f.event(r, "2030-03-03T23:59:59.999Z", 1000) // before the 7 days
    f.event(r, "2030-03-04T00:00:00.000Z", 10) // the 7 days' first instant

    const day = fleetMetrics(f.store, "24h", NOW)
    expect(day.spend_usd).toBe(7)
    expect(day.daily).toEqual([
      { date: "2030-03-09", spend_usd: 3, runs: 0 },
      { date: "2030-03-10", spend_usd: 4, runs: 0 },
    ])

    const week = fleetMetrics(f.store, "7d", NOW)
    expect(week.spend_usd).toBe(117)
    expect(week.daily[0]).toEqual({ date: "2030-03-04", spend_usd: 10, runs: 0 })
  })
})

describe("fleet spend", () => {
  test("missing cost stays apart from a recorded zero, and empty days are zero activity", () => {
    const f = fixture()
    const priced = f.agent("priced")
    const unpriced = f.agent("unpriced")
    const p = f.run(priced, "2030-03-08T10:00:00.000Z")
    const u = f.run(unpriced, "2030-03-09T10:00:00.000Z")
    f.event(p, "2030-03-08T10:01:00.000Z", 0) // a recorded zero
    f.event(u, "2030-03-09T10:01:00.000Z", null, "step", 500) // tokens, no price

    const m = fleetMetrics(f.store, "7d", NOW)
    expect(m.spend_usd).toBe(0)
    expect(m.cost_coverage).toEqual({ priced_reports: 1, unpriced_reports: 1 })
    expect(m.agents.find((a) => a.label === "priced")!.spend_usd).toBe(0)
    expect(m.agents.find((a) => a.label === "unpriced")!.spend_usd).toBeNull()
    const day = (date: string) => m.daily.find((d) => d.date === date)!
    expect(day("2030-03-08")).toEqual({ date: "2030-03-08", spend_usd: 0, runs: 1 })
    expect(day("2030-03-09")).toEqual({ date: "2030-03-09", spend_usd: null, runs: 1 })
    expect(day("2030-03-05")).toEqual({ date: "2030-03-05", spend_usd: 0, runs: 0 })
  })

  test("the total, the top five plus Other, and the daily chart reconcile", () => {
    const f = fixture()
    const costs = [9, 8, 7, 6, 5, 4, 3]
    costs.forEach((cost, i) => {
      const a = f.agent(`agent-${i}`)
      const r = f.run(a, `2030-03-0${4 + (i % 6)}T08:00:00.000Z`)
      f.event(r, `2030-03-0${4 + (i % 6)}T08:30:00.000Z`, cost / 2)
      f.event(r, "2030-03-10T09:00:00.000Z", cost / 2)
    })
    const m = fleetMetrics(f.store, "7d", NOW)
    expect(m.agents.map((a) => a.label)).toEqual(["agent-0", "agent-1", "agent-2", "agent-3", "agent-4"])
    expect(m.other).toEqual({ agents: 2, spend_usd: 7, runs: 2 })
    const total = costs.reduce((s, c) => s + c, 0)
    expect(m.spend_usd).toBeCloseTo(total, 9)
    expect(m.agents.reduce((s, a) => s + a.spend_usd!, 0) + m.other!.spend_usd!).toBeCloseTo(total, 9)
    expect(m.daily.reduce((s, d) => s + d.spend_usd!, 0)).toBeCloseTo(total, 9)
    expect(m.agents.reduce((s, a) => s + a.runs, 0) + m.other!.runs).toBe(m.runs_started)
    expect(m.daily.reduce((s, d) => s + d.runs, 0)).toBe(m.runs_started)
  })
})

describe("fleet runs and refusals", () => {
  test("runs count by start; median covers runs that ended in range with valid timestamps", () => {
    const f = fixture()
    const a = f.agent("runner")
    f.run(a, "2030-03-09T10:00:00.000Z", "2030-03-09T10:01:00.000Z") // 60 s
    f.run(a, "2030-03-09T11:00:00.000Z", "2030-03-09T11:03:00.000Z") // 180 s
    f.run(a, "2030-03-09T12:00:00.000Z", "2030-03-09T12:10:00.000Z") // 600 s
    f.run(a, "2030-03-01T00:00:00.000Z", "2030-03-09T13:00:00.000Z") // started before the 7 days, ended inside
    f.run(a, null, "2030-03-09T13:00:00.000Z", "failed") // never started: no duration
    f.run(a, "2030-03-09T14:00:00.000Z", null, "running") // still running

    const odd = fleetMetrics(f.store, "7d", NOW)
    expect(odd.runs_started).toBe(4)
    expect(odd.completed_runs).toBe(4)
    expect(odd.median_run_ms).toBe((180_000 + 600_000) / 2)

    f.run(a, "2030-03-09T15:00:00.000Z", "2030-03-09T15:00:30.000Z") // 30 s, makes five
    const five = fleetMetrics(f.store, "7d", NOW)
    expect(five.completed_runs).toBe(5)
    expect(five.median_run_ms).toBe(180_000)
  })

  test("refusals count stored events once, however many requests share the run", () => {
    const f = fixture()
    const a = f.agent("refused")
    const r = f.run(a, "2030-03-09T10:00:00.000Z")
    f.event(r, "2030-03-09T10:01:00.000Z", null, "permission_denied")
    f.event(r, "2030-03-09T10:02:00.000Z", null, "permission_denied")
    f.event(r, "2030-02-01T10:02:00.000Z", null, "permission_denied") // outside every range
    for (let i = 0; i < 3; i++) f.request(r, a, "denied", "2030-03-09T10:30:00.000Z")
    expect(fleetMetrics(f.store, "7d", NOW).refused_actions).toBe(2)
  })

  test("awaiting you leaves out expired and decided requests; running is a current snapshot", () => {
    const f = fixture()
    const a = f.agent("waiting")
    const live = f.run(a, "2030-03-10T14:00:00.000Z", null, "running")
    f.request(live, a, "pending", "2030-03-10T15:10:00.000Z") // still open
    f.request(live, a, "pending", "2030-03-10T14:59:59.999Z") // past expiry, not yet swept
    f.request(live, a, "approved_once", "2030-03-10T15:10:00.000Z")
    const m = fleetMetrics(f.store, "24h", NOW)
    expect(m.current).toEqual({ agents_running: 1, awaiting_you: 1 })
  })
})

test("an empty fleet returns zero activity and unknown spend, not an error", () => {
  const f = fixture()
  f.agent("idle")
  const m = fleetMetrics(f.store, "30d", NOW)
  expect(m.spend_usd).toBeNull()
  expect(m.runs_started).toBe(0)
  expect(m.median_run_ms).toBeNull()
  expect(m.refused_actions).toBe(0)
  expect(m.agents).toEqual([])
  expect(m.other).toBeNull()
  expect(m.daily.length).toBe(30)
  expect(m.daily.every((d) => d.spend_usd === 0 && d.runs === 0)).toBe(true)
  expect(JSON.stringify(m)).not.toContain("TRANSCRIPT-MARKER")
})
