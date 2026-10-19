import { api, type FleetMetrics, type FleetRange } from "../api"
import { h, money, replace, replaceIfChanged } from "../dom"
import { button } from "../shared"

const RANGES: Array<[FleetRange, string]> = [
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["30d", "30 days"],
]
// Up to two weeks every day gets a date label; beyond that, every fifth does.
const LABEL_EVERY_DAY_UP_TO = 14
const SPARSE_LABEL_STEP = 5
// "YYYY-MM-DDTHH": the rolling 24 hours redraws when its start crosses an hour.
const ISO_HOUR_LENGTH = 13

const dayLabel = (date: string, weekday = false) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(weekday ? { weekday: "short" } : {}),
  })

const cost = (value: number | null) => (value === null ? "No cost data" : money(value))
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

/** A round top for the USD axis, so the gridlines read as plain numbers. */
function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  return ([1, 2, 2.5, 5, 10].find((step) => step * magnitude >= value) ?? 10) * magnitude
}

/** Sizes through the CSSOM: the page's CSP refuses inline style attributes. */
function sized<T extends HTMLElement>(el: T, property: string, value: string): T {
  el.style.setProperty(property, value)
  return el
}

function card(label: string, value: string, hint: string, options: { now?: boolean; attention?: boolean } = {}) {
  return h(
    "div",
    { class: "stat", "data-tone": options.attention ? "attention" : null },
    h(
      "span",
      { class: "stat-label" },
      h("span", { class: "micro-label" }, label),
      options.now ? h("span", { class: "tag" }, "Now") : null,
    ),
    h("span", { class: "stat-value numeral" }, value),
    h("span", { class: "hint" }, hint),
  )
}

function cards(m: FleetMetrics): HTMLElement {
  const { priced_reports: priced, unpriced_reports: unpriced } = m.cost_coverage
  const spendHint =
    m.spend_usd === null
      ? unpriced
        ? `${plural(unpriced, "usage report")}, none priced`
        : "No cost recorded"
      : unpriced
        ? `Partial: ${unpriced} of ${priced + unpriced} usage reports unpriced`
        : "Reported event costs"
  return h(
    "div",
    { class: "stat-row", "data-count": "6" },
    card("Spend", m.spend_usd === null ? "—" : money(m.spend_usd), spendHint),
    card("Agents running", String(m.current.agents_running), "Live runs", { now: true }),
    card("Runs", String(m.runs_started), "Started in period"),
    card(
      "Median run",
      m.median_run_ms === null ? "—" : duration(m.median_run_ms),
      m.completed_runs ? `Completed-run duration, ${plural(m.completed_runs, "run")}` : "No completed runs",
    ),
    card("Refused actions", String(m.refused_actions), "Denials recorded"),
    card("Awaiting you", String(m.current.awaiting_you), "Open requests", {
      now: true,
      attention: m.current.awaiting_you > 0,
    }),
  )
}

function spendByAgent(m: FleetMetrics): HTMLElement {
  const rows = [
    ...m.agents.map((a) => ({ ...a, href: `#/agents/${a.id}` as string | null })),
    ...(m.other
      ? [
          {
            id: "other",
            label: `Other (${plural(m.other.agents, "agent")})`,
            spend_usd: m.other.spend_usd,
            runs: m.other.runs,
            href: null,
          },
        ]
      : []),
  ]
  const top = Math.max(0, ...rows.map((r) => r.spend_usd ?? 0))
  return h(
    "section",
    { class: "panel chart-panel", "aria-labelledby": "spend-agent-title" },
    h("div", { class: "section-head" }, h("h3", { class: "micro-label", id: "spend-agent-title" }, "Spend by agent")),
    rows.length
      ? h(
          "ol",
          { class: "agent-bars" },
          ...rows.map((r) =>
            h(
              "li",
              { class: "agent-bar" },
              h(
                "div",
                { class: "agent-bar-head" },
                r.href
                  ? h("a", { class: "name-link", href: r.href, "data-focus-key": `agent:${r.id}` }, r.label)
                  : h("span", { class: "muted" }, r.label),
                h(
                  "span",
                  { class: "agent-bar-value" },
                  h("span", { class: "numeral" }, cost(r.spend_usd)),
                  h("span", { class: "hint" }, plural(r.runs, "run")),
                ),
              ),
              h(
                "div",
                { class: "bar-track", "aria-hidden": "true" },
                sized(
                  h("span", { class: "bar-fill", "data-other": r.href ? null : "true" }),
                  "width",
                  `${top > 0 && r.spend_usd ? Math.max(1, (r.spend_usd / top) * 100) : 0}%`,
                ),
              ),
            ),
          ),
        )
      : h("p", { class: "chart-empty muted" }, "No recorded spend or runs in this period."),
  )
}

function spendPerDay(m: FleetMetrics, selected: { date: string | null }): HTMLElement {
  const days = m.daily
  const top = niceMax(Math.max(0, ...days.map((d) => d.spend_usd ?? 0)))
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => top * f)
  const total = days.reduce((sum, d) => sum + (d.spend_usd ?? 0), 0)
  const highest = days.reduce<(typeof days)[number] | null>(
    (best, d) => ((d.spend_usd ?? 0) > (best?.spend_usd ?? 0) ? d : best),
    null,
  )
  const labelEvery = days.length > LABEL_EVERY_DAY_UP_TO ? SPARSE_LABEL_STEP : 1
  const describe = (d: (typeof days)[number]) =>
    `${dayLabel(d.date, true)}: ` +
    `${d.spend_usd === null ? "activity without cost data" : `${money(d.spend_usd)} recorded`}, ` +
    `${plural(d.runs, "run")} started`

  if (!selected.date || !days.some((d) => d.date === selected.date))
    selected.date = (highest ?? days[days.length - 1]).date
  const readout = h("p", { class: "day-readout", "aria-live": "polite" })
  // Unchanged text is not announced again when focus is handed back after a redraw.
  const preview = (d: (typeof days)[number]) => {
    if (readout.textContent !== describe(d)) replace(readout, describe(d))
  }
  // The one place the selection changes, so a click, focus and an arrow key all
  // move the single tab stop with it. Hover only previews: a pointer resting on
  // the chart must not pull the tab stop away from the focused day.
  const show = (d: (typeof days)[number]) => {
    selected.date = d.date
    bars.forEach((bar, i) => {
      const current = days[i].date === d.date
      bar.tabIndex = current ? 0 : -1
      bar.setAttribute("aria-current", current ? "true" : "false")
    })
    preview(d)
  }

  const bars = days.map((d, i) => {
    const bar = h(
      "button",
      {
        type: "button",
        class: "day-bar",
        "aria-label": describe(d),
        tabindex: -1,
        "data-focus-key": `day:${d.date}`,
        "data-nocost": d.spend_usd === null ? "true" : null,
      },
      sized(h("span", { class: "day-bar-fill" }), "height", `${((d.spend_usd ?? 0) / top) * 100}%`),
    )
    bar.addEventListener("pointerenter", () => preview(d))
    bar.addEventListener("pointerleave", () => preview(days.find((day) => day.date === selected.date)!))
    bar.addEventListener("focus", () => show(d))
    bar.addEventListener("click", () => show(d))
    bar.addEventListener("keydown", (event) => {
      const next =
        event.key === "ArrowRight"
          ? i + 1
          : event.key === "ArrowLeft"
            ? i - 1
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? days.length - 1
                : null
      if (next === null || next < 0 || next >= days.length) return
      event.preventDefault()
      bars[next].focus()
    })
    return bar
  })
  show(days.find((d) => d.date === selected.date)!)

  return h(
    "section",
    { class: "panel chart-panel", "aria-labelledby": "spend-day-title" },
    h(
      "div",
      { class: "section-head" },
      h("h3", { class: "micro-label", id: "spend-day-title" }, "Spend per day"),
      h("span", { class: "hint" }, "UTC days"),
    ),
    h(
      "div",
      { class: "day-summary" },
      h(
        "span",
        {},
        "Period total ",
        h("strong", { class: "numeral" }, m.spend_usd === null ? "No cost data" : money(total)),
      ),
      highest && highest.spend_usd
        ? h("span", {}, "Highest day ", h("strong", {}, `${dayLabel(highest.date)} (${money(highest.spend_usd)})`))
        : null,
    ),
    sized(
      h(
        "div",
        { class: "day-chart" },
        h("div", { class: "day-axis", "aria-hidden": "true" }, ...ticks.map((t) => h("span", {}, money(t)))),
        h(
          "div",
          { class: "day-plot" },
          h("div", { class: "day-grid", "aria-hidden": "true" }, ...ticks.map(() => h("span"))),
          h(
            "div",
            {
              class: "day-bars",
              role: "group",
              "aria-label": "Spend per day; use the arrow keys to move between days",
            },
            ...bars,
          ),
          h(
            "div",
            { class: "day-labels", "aria-hidden": "true" },
            ...days.map((d, i) => h("span", {}, i % labelEvery === 0 || i === days.length - 1 ? dayLabel(d.date) : "")),
          ),
        ),
      ),
      "--days",
      String(days.length),
    ),
    readout,
    h(
      "table",
      { class: "visually-hidden" },
      h("caption", {}, "Recorded spend and runs started per UTC day"),
      h("thead", {}, h("tr", {}, h("th", {}, "Day"), h("th", {}, "Spend"), h("th", {}, "Runs started"))),
      h(
        "tbody",
        {},
        ...days.map((d) => h("tr", {}, h("td", {}, d.date), h("td", {}, cost(d.spend_usd)), h("td", {}, d.runs))),
      ),
    ),
  )
}

/**
 * The fleet's recent activity: six cards and two charts for one interval.
 * A failed load says so instead of showing zeros, which would read as a quiet fleet.
 */
export function activityPanel(): { element: HTMLElement; refresh: () => Promise<void> } {
  let range: FleetRange = "7d"
  let latest = 0
  const selected = { date: null as string | null }
  const body = h(
    "div",
    { class: "activity-body", "aria-busy": "true" },
    h("p", { class: "panel activity-state muted" }, "Loading activity…"),
  )

  const toggles = RANGES.map(([value, label]) => {
    const toggle = button(label, {
      onclick: () => {
        if (range === value) return
        range = value
        selected.date = null
        toggles.forEach((t, i) => t.setAttribute("aria-pressed", String(RANGES[i][0] === range)))
        void refresh()
      },
    })
    toggle.setAttribute("aria-pressed", String(value === range))
    return toggle
  })

  const refresh = async () => {
    const request = ++latest
    const requested = range
    body.setAttribute("aria-busy", "true")
    try {
      const m = await api.get<FleetMetrics>(`/api/fleet/metrics?range=${requested}`)
      if (request !== latest) return
      const empty =
        m.spend_usd === null &&
        m.runs_started === 0 &&
        m.refused_actions === 0 &&
        m.completed_runs === 0 &&
        m.agents.length === 0
      // A redraw replaces every node, so note what had focus and hand it back
      // afterwards: a live update must not strand someone using the keyboard.
      const active = document.activeElement
      const focusKey = active instanceof HTMLElement && body.contains(active) ? active.dataset.focusKey : undefined
      // The interval's ends move every second; only the figures decide a redraw.
      const key = JSON.stringify({ ...m, from: m.from.slice(0, ISO_HOUR_LENGTH), to: null })
      const redrawn = replaceIfChanged(body, key, () => [
        h("div", { class: "panel" }, cards(m)),
        empty
          ? h("p", { class: "panel activity-state muted" }, "No recorded activity in this period.")
          : h("div", { class: "activity-charts" }, spendByAgent(m), spendPerDay(m, selected)),
        h(
          "p",
          { class: "hint activity-note" },
          `${dayLabel(m.from.slice(0, 10))} to ${dayLabel(m.to.slice(0, 10))}, UTC. ` +
            "Spend is the sum of costs runners reported, not a provider bill. " +
            "Refused actions count recorded denials, not unique prompts.",
        ),
      ])
      if (redrawn && focusKey) {
        // A day that rolled out of the interval falls back to the selected one.
        const target =
          body.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`) ??
          (focusKey.startsWith("day:") ? body.querySelector<HTMLElement>(".day-bar[tabindex='0']") : null)
        target?.focus({ preventScroll: true })
      }
    } catch (err) {
      if (request !== latest) return
      replaceIfChanged(body, `error:${requested}`, () => [
        h(
          "div",
          { class: "panel activity-state", role: "alert" },
          h("p", {}, `Couldn't load fleet activity: ${(err as Error).message}`),
          button("Retry", { onclick: () => void refresh() }),
        ),
      ])
    } finally {
      if (request === latest) body.setAttribute("aria-busy", "false")
    }
  }

  const element = h(
    "section",
    { class: "activity", "aria-labelledby": "activity-title" },
    h(
      "div",
      { class: "section-title" },
      h("h2", { class: "micro-label", id: "activity-title" }, "Fleet activity"),
      h("div", { class: "range-toggle", role: "group", "aria-label": "Time range (UTC)" }, ...toggles),
    ),
    body,
  )
  return { element, refresh }
}
