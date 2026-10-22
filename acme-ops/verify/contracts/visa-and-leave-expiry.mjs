import { action, actionKind, agent, check, eq, runs, start, asCase } from "./lib.mjs";

// Executable expectations for work-authorization and leave dates (Notion HR
// register rows, Kit v2 timers that stand down when the row changes, Asana
// counsel case, Gmail draft, Calendar meeting). Notion, Asana, Gmail, Calendar
// and Slack have FetchSandbox twins. seed() finds a database in the Notion twin
// and creates each check's register row there; the page ids are swapped into
// the inputs. Properties the twin refuses are recorded.
const HR = "C0HRCOMPL01";
const DAY = 86_400_000;
const date = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const page = (c) => `00000000000000000000000000${String(Object.keys(FIXTURES).indexOf(c)).padStart(6, "0")}`;
const input = (c, over = {}) => ({ eventId: `evt_${c}`.slice(0, 68), pageId: page(c), hrChannel: HR, hrCalendarId: "hr@acme.example", ...over });
const changed = (c, over) => start(c, input(c, over));
const FIXTURES = {
  baseline: { type: "work_authorization", days: 120 },
  authorization_timers_scheduled: { type: "work_authorization", days: 200 },
  counsel_case_inside_90_days: { type: "work_authorization", days: 60 },
  renewed_row_schedules_nothing: { type: "work_authorization", days: 60, status: "renewed" },
  leave_return_planned: { type: "leave", days: 10 },
  expiry_escalates_reverification: { type: "work_authorization", days: 1 },
  unrelated_row_ignored: { type: "equipment", days: 10 },
};

export const checks = [
  check("baseline", "A request starts one recorded run (provider-independent, so every later check is measured)", [changed("baseline")], runs([], 1)),
  // Until 2026-10-22 this was the baseline; moved so a missing or divergent twin fails only this check.
  check("baseline_effects", "A register row is read and classified", [asCase("baseline_effects", changed("baseline"))], runs([agent("register", "ok"), eq("output.mode", "work_authorization")])),
  check("authorization_timers_scheduled", "An authorization 200 days out gets 180/90/30-day notices, a counsel case and an expiry escalation scheduled", [changed("authorization_timers_scheduled")], runs([actionKind("hr.auth_notice", "scheduled", 3), action("asana.counsel_case", "scheduled"), action("hr.reverification_overdue", "scheduled")])),
  check("counsel_case_inside_90_days", "An authorization already inside 90 days opens the counsel case at once", [changed("counsel_case_inside_90_days")], runs([action("asana.counsel_case", "applied")])),
  check("renewed_row_schedules_nothing", "A row marked renewed schedules nothing", [changed("renewed_row_schedules_nothing")], runs([eq("output.status", "renewed"), actionKind("hr.auth_notice", null, 0), actionKind("asana.counsel_case", null, 0)])),
  check("leave_return_planned", "A leave ending in 10 days gets the return email and the manager meeting at once", [changed("leave_return_planned")], runs([action("gmail.return_planning", "applied"), action("calendar.return_meeting", "applied"), action("hr.return_check", "scheduled")])),
  check("expiry_escalates_reverification", "On the expiry date the row is marked overdue and HR is told (needs clock control)", [changed("expiry_escalates_reverification"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([action("hr.reverification_overdue", "applied")])),
  check("unrelated_row_ignored", "A row that isn't an authorization or a leave is ignored", [changed("unrelated_row_ignored")], runs([eq("output.mode", "ignored")])),
  check("invalid_input_rejected", "A malformed page id is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), pageId: "Priya's visa" }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const leg = legs.notion;
  const trail = [];
  const call = async (method, path, json) => {
    const res = await fetch(`${leg.base_url}${path}`, { method, headers: { authorization: `Bearer ${leg.api_key}`, "content-type": "application/json", "Notion-Version": "2022-06-28" }, body: json ? JSON.stringify(json) : undefined });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    if (!res.ok) trail.push(`${method} ${path} ${res.status} ${text.slice(0, 300)}`);
    return res.ok ? body : null;
  };
  const found = await call("POST", "/v1/search", { filter: { property: "object", value: "database" }, page_size: 5 });
  const db = found?.results?.[0]?.id;
  const ids = {};
  for (const [c, f] of Object.entries(FIXTURES)) {
    if (!db) break;
    const props = { Employee: { title: [{ text: { content: `Seed ${c}` } }] }, Email: { email: `${c.replaceAll("_", "-")}@acme.example` }, "Manager email": { email: "manager@acme.example" }, Type: { select: { name: f.type } }, Document: { select: { name: "H-1B" } }, Date: { date: { start: date(f.days) } }, Status: { select: { name: f.status ?? "active" } } };
    const p = await call("POST", "/v1/pages", { parent: { database_id: db }, properties: props });
    if (p?.id) ids[c] = p.id.replaceAll("-", "");
  }
  for (const [i, chk] of checks.entries()) {
    const key = chk.id === "baseline_effects" ? "baseline" : chk.id;
    if (ids[key]) checks[i] = JSON.parse(JSON.stringify(chk).replaceAll(page(key), ids[key]));
  }
  log("seed database", db ?? "none", ";", Object.keys(ids).length, "rows;", trail.slice(0, 6).join("; "));
  return { db, ids, trail };
}

export default {
  workflow: "visa-and-leave-expiry",
  providers: ["notion", "asana", "gmail", "google-calendar", "slack"],
  seed,
  context: {
    goal: "Prove the visa-and-leave-expiry AgentCore runtime: a Notion HR register row (work authorization or leave) → durable timers from its date: authorization notices at 180/90/30 days, an Asana immigration-counsel case at 90 days, an I-9 reverification escalation (row marked overdue) on expiry; leave return-planning email draft and manager meeting 14 days before return and an extension check the day after; every timer re-reads the row and stands down if its date or status changed.",
    workflow: "POST /invocations {action:start} per row change; {action:tick} fires due timers. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline", "baseline_effects"],
    identity_and_access: "Notices go to HR and counsel only; the employee gets a draft, never an automatic send.",
    schema_and_value_boundaries: ["invalid_input_rejected", "unrelated_row_ignored"],
    amount_currency_quantity: ["authorization_timers_scheduled"],
    duplicate_replay: "Each timer re-reads the row; an edited row's older run stands down (local tests).",
    concurrency: "The newest run for a row owns it; older runs skip.",
    ordering_and_stale_events: ["renewed_row_schedules_nothing"],
    delayed_or_missing_events: ["expiry_escalates_reverification"],
    provider_auth_and_scopes: "An unreadable row schedules nothing and HR is told (local tests).",
    rate_limit_server_error_timeout: "An unreadable row schedules nothing and HR is told (local tests).",
    accepted_effect_response_loss: "Calendar events carry a private key for retries.",
    partial_effects_and_recovery: ["counsel_case_inside_90_days"],
    restart_and_durability: "Timers months out survive restarts (Kit v2 tests).",
    reconciliation: "Every timer re-reads the register row before acting.",
    cancellation_refund_entitlements: ["leave_return_planned"],
    data_and_privacy_boundaries: "Immigration details stay in HR channels; the Asana case carries the row id and document type.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/visa-and-leave-expiry.ts", "acme-ops/test/visa-and-leave-expiry.test.ts"],
};
