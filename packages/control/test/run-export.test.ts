import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { startControl, type RunningControl } from "../src/server"

let control: RunningControl
let base: string
let adminToken: string
let dataDir: string

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-export-"))
  control = await startControl({
    port: 0,
    hostname: "127.0.0.1",
    dataDir,
    publicUrl: "http://127.0.0.1:0",
    binariesDir: null,
    tls: null,
    log: () => {},
  })
  base = `http://127.0.0.1:${control.server.port}`
  adminToken = control.newAdminToken!
})

afterAll(async () => {
  await control.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const admin = (method: string, p: string, body?: unknown, token?: string | null) =>
  fetch(`${base}${p}`, {
    method,
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token ?? adminToken}` }),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function makeAgentWithRun(label: string) {
  const created = (await (
    await admin("POST", "/api/agents", { label, task: "t", model_provider: "anthropic", model_name: "m" })
  ).json()) as any
  const minted = (await (await admin("POST", `/api/agents/${created.id}/install-command`)).json()) as any
  return { agent: created, runId: minted.run_id as string }
}

describe("run NDJSON export", () => {
  test("exports more than one thousand events exactly once in order", async () => {
    const { agent, runId } = await makeAgentWithRun("export-order")
    for (let i = 0; i < 1200; i++) control.store.addEvent(runId, "step", { n: i })
    const res = await admin("GET", `/api/agents/${agent.id}/runs/${runId}/export`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/x-ndjson")
    expect(res.headers.get("content-disposition")).toContain(".ndjson")
    const lines = (await res.text()).trim().split("\n")
    expect(lines.length).toBe(1201)
    const meta = JSON.parse(lines[0])
    expect(meta.format).toBe("agents-everywhere.run-export/1")
    expect(meta.through_seq).toBe(1200)
    expect(meta.run_id).toBe(runId)
    expect(meta.agent_id).toBe(agent.id)
    const seqs = lines.slice(1).map((l) => JSON.parse(l).seq)
    expect(seqs).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1))
  })

  test("every record carries format, run and agent identity with usage", async () => {
    const { agent, runId } = await makeAgentWithRun("export-shape")
    control.store.addEvent(runId, "step", { kind: "reply", message: "hi" })
    const res = await admin("GET", `/api/agents/${agent.id}/runs/${runId}/export`)
    const lines = (await res.text()).trim().split("\n")
    expect(lines.length).toBe(2)
    const meta = JSON.parse(lines[0])
    const record = JSON.parse(lines[1])
    expect(record.format).toBe("agents-everywhere.run-export/1")
    expect(record.agent_id).toBe(agent.id)
    expect(record.run_id).toBe(runId)
    expect(record.seq).toBe(meta.through_seq)
    expect(record.event_type).toBe("step")
    expect(record.created_at).toBeTruthy()
    expect("tokens_in" in record && "cost_usd" in record).toBe(true)
  })

  test("a fixed snapshot excludes later events, even mid-stream", async () => {
    const { agent, runId } = await makeAgentWithRun("export-snapshot")
    for (let i = 0; i < 2500; i++) control.store.addEvent(runId, "step", { n: i })
    const res = await admin("GET", `/api/agents/${agent.id}/runs/${runId}/export`)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    let text = ""
    let grew = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
      if (!grew) {
        grew = true
        for (let i = 0; i < 300; i++) control.store.addEvent(runId, "step", { late: i })
      }
    }
    const lines = text.trim().split("\n")
    const meta = JSON.parse(lines[0])
    const seqs = lines.slice(1).map((l) => JSON.parse(l).seq)
    expect(Math.max(...seqs)).toBeLessThanOrEqual(meta.through_seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    // A fresh export afterwards sees the growth under a new boundary.
    const res2 = await admin("GET", `/api/agents/${agent.id}/runs/${runId}/export`)
    const lines2 = (await res2.text()).trim().split("\n")
    expect(JSON.parse(lines2[0]).through_seq).toBe(meta.through_seq + 300)
    expect(lines2.length).toBe(lines.length + 300)
  })

  test("authentication, ownership, empty and invalid runs", async () => {
    const { agent, runId } = await makeAgentWithRun("export-auth")
    expect((await admin("GET", `/api/agents/${agent.id}/runs/${runId}/export`, undefined, null)).status).toBe(401)
    expect((await admin("GET", `/api/agents/nope/runs/${runId}/export`)).status).toBe(404)
    expect((await admin("GET", `/api/agents/${agent.id}/runs/nope/export`)).status).toBe(404)
    const other = (await (
      await admin("POST", "/api/agents", { label: "export-other", task: "t", model_provider: "anthropic", model_name: "m" })
    ).json()) as any
    expect((await admin("GET", `/api/agents/${other.id}/runs/${runId}/export`)).status).toBe(404)
    const empty = await admin("GET", `/api/agents/${agent.id}/runs/${runId}/export`)
    expect(empty.status).toBe(200)
    const lines = (await empty.text()).trim().split("\n")
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]).through_seq).toBe(0)
  })
})
