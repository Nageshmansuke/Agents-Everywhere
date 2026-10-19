import { api, type AgentSummary } from "../api"
import { agoNode, h, money, refreshTimes, replace, replaceIfChanged } from "../dom"
import { icon } from "../icons"
import { poll } from "../poll"
import { linkButton, runStatus } from "../shared"
import { activityPanel } from "./activity"

const REFRESH_MS = 10_000
// Below this a list is short enough to scan; above it, it gets a search box.
const SEARCH_THRESHOLD = 6

function row(a: AgentSummary): HTMLElement {
  const modeTag = a.status === "revoked" ? "Revoked" : a.permission_mode === "request" ? "Asks first" : "Strict"
  return h(
    "tr",
    {},
    h(
      "td",
      { "data-label": "Agent" },
      h(
        "div",
        { class: "cell-name" },
        h("a", { class: "name-link", href: `#/agents/${a.id}` }, a.label),
        h("span", { class: "inline" }, h("span", { class: "tag" }, modeTag)),
      ),
    ),
    h("td", { "data-label": "Model" }, h("span", { class: "machine-label" }, `${a.model_provider}/${a.model_name}`)),
    h(
      "td",
      { "data-label": "Last run" },
      h(
        "div",
        { class: "cell-name" },
        runStatus(a.latest_run_status),
        a.latest_run_last_heartbeat_at
          ? h("span", { class: "hint" }, "heard ", agoNode(a.latest_run_last_heartbeat_at))
          : null,
      ),
    ),
    h(
      "td",
      { "data-label": "Awaiting you" },
      a.pending_permission_requests
        ? h("span", { class: "request-badge status", "data-tone": "warning" }, `${a.pending_permission_requests} waiting`)
        : h("span", { class: "hint" }, "Nothing"),
    ),
    h("td", { class: "num", "data-label": "Spend" }, h("span", { class: "numeral" }, money(a.total_cost_usd))),
  )
}

export async function renderList(main: HTMLElement): Promise<() => void> {
  let agents = await api.get<AgentSummary[]>("/api/agents")
  let query = ""

  const activity = activityPanel()
  const table = h("tbody")
  const count = h("span", { class: "micro-label" })
  const searchInput = h("input", { type: "search", placeholder: "Search agents", "aria-label": "Search agents" })
  const search = h("label", { class: "search" }, icon("search"), searchInput)
  searchInput.addEventListener("input", () => {
    query = searchInput.value.trim().toLowerCase()
    drawTable(true)
  })

  const drawTable = (force = false) => {
    const shown = agents.filter(
      (a) => !query || `${a.label} ${a.model_provider}/${a.model_name}`.toLowerCase().includes(query),
    )
    search.hidden = agents.length <= SEARCH_THRESHOLD
    replace(count, query ? `${shown.length} of ${agents.length}` : `${agents.length}`)
    const key = shown.map((a) => `${a.id}:${a.latest_run_status}:${a.pending_permission_requests}:${a.total_cost_usd}`).join(",")
    if (force) replace(table)
    replaceIfChanged(table, key, () =>
      shown.length
        ? shown.map(row)
        : [h("tr", {}, h("td", { colspan: 5, class: "muted" }, "No agent matches that search."))],
    )
  }

  const masthead = h(
    "div",
    { class: "masthead" },
    h(
      "div",
      { class: "masthead-text" },
      h("h1", {}, "Agents"),
      h(
        "p",
        {},
        "Describe a task, choose what the agent may touch, and paste one install command. It works on your own machine and reports what it did and what it cost back here.",
      ),
    ),
    linkButton("New agent", "#/new", "plus", true),
  )

  if (agents.length === 0) {
    replace(
      main,
      masthead,
      h(
        "section",
        { class: "panel empty" },
        h("h2", {}, "No agents yet"),
        h("p", {}, "Create one, then run its install command on the machine it should work on."),
        linkButton("New agent", "#/new", "plus", true),
      ),
    )
    return () => {}
  }

  replace(
    main,
    masthead,
    activity.element,
    h("div", { class: "section-title" }, h("h2", { class: "micro-label" }, "Fleet"), h("div", { class: "inline" }, search, count)),
    h(
      "section",
      { class: "panel" },
      h(
        "table",
        { class: "grid-table" },
        h("caption", { class: "visually-hidden" }, "Agents"),
        h(
          "thead",
          {},
          h("tr", {}, h("th", {}, "Agent"), h("th", {}, "Model"), h("th", {}, "Last run"), h("th", {}, "Awaiting you"), h("th", { class: "num" }, "Spend")),
        ),
        table,
      ),
    ),
  )
  drawTable()
  void activity.refresh()

  return poll(REFRESH_MS, async () => {
    // Settles on its own, showing its error in place, so the list refreshes regardless.
    void activity.refresh()
    agents = await api.get<AgentSummary[]>("/api/agents")
    drawTable()
    refreshTimes(main)
  })
}

