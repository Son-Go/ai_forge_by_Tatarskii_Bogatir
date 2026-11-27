import { translate } from "./i18n.js";

const byId = (id) => document.getElementById(id);
const all = (selector) => [...document.querySelectorAll(selector)];
const pages = ["overview", "workers", "settings", "costs"];
const profiles = {
  economy: [0, 1], always_ready: [1, 1], autoscaling: [0, 2], ready_with_capacity: [1, 2],
};
const formIds = ["worker-form", "settings-form"];
const forms = Object.fromEntries(formIds.map((id) => [id, { form: byId(id), base: null, dirty: false }]));
const dialog = byId("confirmation");
const chartFields = ["requests", "failed", "execution_p95", "queue_p95", "cold_starts"];
let lang = localStorage.getItem("runpod-panel-language") === "en" ? "en" : "ru";
let page = "overview";
let state;
let metrics;
let costs;
let localNotice;
let stateError;
let probeResult;
let probePolling = false;
let probeVersion = 0;
const probePending = new Set(["probe_queued", "probe_processing"]);
let confirmation;
let operation;
let stateRequest = 0;
let pageRequest = 0;

const t = (key, values) => translate(lang, key, values);
const number = (value) => value == null ? t("unavailable") : new Intl.NumberFormat(lang).format(value);
const money = (value) => value == null ? t("unavailable") : new Intl.NumberFormat(lang, {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 12,
}).format(value);
const dateTime = (value) => new Intl.DateTimeFormat(lang, { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
const clock = (value) => new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function table(headings, rows, className) {
  const node = element("table", null, className);
  const heading = node.createTHead().insertRow();
  for (const text of headings) {
    const cell = element("th", text);
    cell.scope = "col";
    heading.append(cell);
  }
  const body = node.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) row.insertCell().textContent = value;
  }
  return node;
}

function message(node, result, style) {
  node.hidden = !result;
  node.className = ["message", style].filter(Boolean).join(" ");
  node.textContent = result ? [t(result.status), result.reason && t(result.reason)].filter(Boolean).join(" ") : "";
}

async function request(path, method = "GET", data) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: method === "GET" ? {} : { "x-panel-request": "1", "content-type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(method === "GET" ? 20000 : path === "/api/probe" ? 132000 : 27000),
    });
  } catch {
    throw new Error("network_error");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "unexpected_error");
  return result;
}

function applyLanguage() {
  document.documentElement.lang = lang;
  all("[data-i]").forEach((node) => { node.textContent = t(node.dataset.i); });
  all("[data-aria]").forEach((node) => node.setAttribute("aria-label", t(node.dataset.aria)));
  all("[data-lang]").forEach((button) => button.setAttribute("aria-pressed", String(lang === button.dataset.lang)));
  renderState();
  renderPageData();
  if (confirmation) renderConfirmation();
}

function renderForms() {
  const current = state?.endpoint?.data;
  const locked = !current || Boolean(state?.pending) || operation === "apply";
  const worker = forms["worker-form"];
  const settings = forms["settings-form"];

  if (current && !worker.dirty && current.revision !== worker.base?.revision) {
    worker.base = current;
    for (const key of ["active", "max", "idle_timeout"]) worker.form.elements[key].value = current[key] ?? "";
  }
  if (current && !settings.dirty && current.revision !== settings.base?.revision) {
    settings.base = current;
    for (const key of ["name", "image", "execution_timeout", "flashboot"]) {
      settings.form.elements[key].value = current[key] ?? "";
    }
    const { type, queueDelay, requestCount } = current.scaling;
    settings.form.elements.scaling_type.value = type ?? "";
    settings.form.elements.threshold.value = queueDelay ?? requestCount ?? "";
  }
  for (const { form } of Object.values(forms)) form.querySelector("fieldset").disabled = locked;
  settings.form.querySelector('[value="QUEUE_DELAY"]').disabled = current?.type !== "QUEUE";

  const elements = worker.form.elements;
  const active = elements.active.valueAsNumber;
  const max = elements.max.valueAsNumber;
  elements.idle_timeout.disabled = !worker.base?.idle_supported || active >= max;
  byId("idle-hint").textContent = t(
    !worker.base?.idle_supported ? "idle_scaler" : active >= max ? "idle_equal" : "idle_hint",
  );
  const queue = settings.form.elements.scaling_type.value === "QUEUE_DELAY";
  const threshold = settings.form.elements.threshold;
  threshold.min = queue ? "0.5" : "1";
  threshold.step = queue ? "any" : "1";
  byId("threshold-label").textContent = t(queue ? "queue_threshold" : "count_threshold");
  byId("threshold-hint").textContent = t(queue ? "queue_hint" : "count_hint");

  all("[data-profile]").forEach((button) => {
    const [min, cap] = profiles[button.dataset.profile];
    button.classList.toggle("selected", current?.active === min && current?.max === cap);
    button.disabled = locked || operation === "preview";
  });
  byId("warm").disabled = locked || operation === "preview" || current?.active !== 0 || current?.max < 1;
}

function renderState() {
  const current = state?.endpoint?.data;
  const workers = state?.workers?.data;
  byId("page-title").textContent = t(page);
  document.title = t(page) + " · Runpod";
  byId("endpoint-name").textContent = current?.name ?? "Runpod Serverless";
  const remoteError = stateError || state?.endpoint?.error;
  message(byId("network-status"), remoteError ? { status: remoteError } : null, "warning");
  const result = localNotice || (operation === "apply" ? { status: "applying" } : state?.result);
  const success = ["applied", "timer_cancelled", "timer_restored", "applying"].includes(result?.status);
  message(byId("write-status"), result, success ? "" : "warning");
  const readiness = byId("application-readiness");
  readiness.hidden = !["workers", "settings"].includes(page)
    || !["applied", "timer_restored"].includes(result?.status);
  readiness.textContent = workers ? t("application_readiness", {
    ready: number(workers.ready), busy: number(workers.busy), starting: number(workers.starting),
    problem: number(workers.problem),
  }) : t("application_readiness_unavailable");
  byId("pending-review").hidden = !state?.pending;
  byId("review").disabled = operation === "review";
  for (const key of ["ready", "busy", "starting", "problem"]) byId(key).textContent = number(workers?.[key]);
  byId("worker-observed").textContent = workers?.observed_at
    ? t("observed", { time: clock(workers.observed_at) }) : "";
  const workerNotes = [];
  if (workers?.runtime_active != null || workers?.jobs_in_progress != null) {
    workerNotes.push(t("queue_runtime", {
      active: number(workers.runtime_active), jobs: number(workers.jobs_in_progress),
    }));
  }
  if (workers?.inactive_idle > 0) {
    workerNotes.push(t("inactive_idle", { count: number(workers.inactive_idle) }));
  }
  if (workers?.stale_workers > 0) {
    workerNotes.push(t("stale_inventory", {
      count: number(workers.stale_workers), ready: number(workers.current_ready),
    }));
  }
  if (workers?.runtime_error) workerNotes.push(t("queue_runtime_unavailable"));
  byId("rollout-status").textContent = workerNotes.join(" ")
    || (workers ? "" : t(state?.workers?.error ?? (state ? "unavailable" : "loading")));
  byId("active-stat").textContent = number(current?.active);
  byId("max-stat").textContent = number(current?.max);
  byId("concurrency").textContent = state?.ml_concurrency
    ? t("concurrency_value", { value: number(state.ml_concurrency) }) : t("concurrency_unavailable");

  const timer = state?.timer;
  byId("timer-status").textContent = timer
    ? t(timer.status, { time: dateTime(timer.until) }) : t(state ? "timer_none" : "loading");
  byId("endpoint-type").textContent = t(current?.type ?? "unavailable");
  const env = byId("environment");
  env.replaceChildren(...(current?.env_names?.length
    ? current.env_names.map((name) => element("li", name))
    : [element("li", t(current?.env_names ? "environment_empty" : "unavailable"))]));
  byId("grafana").hidden = !state?.grafana_url;
  if (state?.grafana_url) byId("grafana").href = state.grafana_url;
  renderForms();
  renderProbe();
  if (page === "costs") renderEstimate(byId("current-estimate"), state?.estimate);
}

async function refreshState() {
  const sequence = ++stateRequest;
  try {
    const latest = await request("/api/state");
    if (sequence !== stateRequest) return;
    state = latest;
    stateError = null;
  } catch (error) {
    if (sequence !== stateRequest) return;
    stateError = error.message;
    state = undefined;
  }
  renderState();
}

function renderProbe() {
  const seconds = state?.probe_timeout_seconds;
  const duration = seconds % 60 === 0
    ? t("probe_minutes", { time: number(seconds / 60) })
    : t("probe_seconds", { time: number(seconds) });
  byId("probe-budget").textContent = state?.probe_enabled ? t("probe_budget", { duration }) : "";
  const status = probeResult?.status;
  const pending = probePending.has(status);
  byId("probe").disabled = !state?.probe_enabled || !state?.endpoint?.data
    || status === "probe_running" || pending;
  const output = byId("probe-result");
  const result = probeResult ?? (state && !state.probe_enabled ? { status: "probe_disabled" } : null);
  output.hidden = !result;
  if (!result) {
    output.textContent = "";
    return;
  }
  const waiting = pending || status?.includes("timeout") || status?.includes("_expired");
  const elapsed = result.elapsed_ms == null ? "" : waiting
    ? t("probe_waited", { time: number(Math.round(result.elapsed_ms / 1000)) })
    : t("elapsed", { time: number(result.elapsed_ms) });
  const note = result.status_error ? t("probe_status_delayed") : "";
  output.textContent = [t(result.status), elapsed, note].filter(Boolean).join(" ");
}

async function refreshProbe() {
  if (probePolling || probeResult?.status === "probe_running") return;
  probePolling = true;
  const version = probeVersion;
  try {
    const current = await request("/api/probe");
    if (current && version === probeVersion) probeResult = current;
  } catch {
    if (probePending.has(probeResult?.status)) probeResult.status_error = "network_error";
  } finally {
    probePolling = false;
    renderProbe();
  }
}

function renderEstimate(container, estimate) {
  if (!estimate) {
    container.replaceChildren(element("p", t("unavailable"), "muted"));
    return;
  }
  const list = element("dl", null, "estimate");
  for (const key of ["active_hour", "ceiling_hour", "warm_two_hours", "active_rate", "flex_rate", "source"]) {
    const item = element("div");
    item.append(
      element("dt", t(key === "source" ? "rate_source" : key)),
      element("dd", key === "source" ? estimate[key] || t("unavailable") : money(estimate[key])),
    );
    list.append(item);
  }
  container.replaceChildren(list, element("p", t("estimate_hint"), "muted"));
}

function tile(label, value, note) {
  const node = element("article", null, "tile");
  node.append(element("span", label), element("strong", value));
  if (note) node.append(element("small", note, "muted"));
  return node;
}

function renderCosts() {
  const tiles = [];
  for (const key of ["today", "week", "month"]) {
    const item = costs?.[key];
    tiles.push(tile(t(key), item ? money(item.data?.total) : t("loading"), item?.error && t(item.error)));
  }
  const balance = costs?.balance;
  tiles.push(tile(t("balance"), balance ? money(balance.data?.amount) : t("loading"),
    balance?.error ? t(balance.error) : balance?.data && t(balance.data.mode)));
  byId("cost-tiles").replaceChildren(...tiles);
  const period = costs?.[byId("billing-period").value];
  const target = byId("daily-costs");
  if (!period?.data) {
    target.replaceChildren(element("p", t(period?.error ?? "loading"), "muted"));
    return;
  }
  target.replaceChildren(table([t("date"), t("amount")],
    period.data.records.map((row) => [row.day, money(row.amount)]), "cost-table"));
  if (!period.data.records.some((row) => row.amount !== null)) {
    target.prepend(element("p", t("no_records"), "muted"));
  }
}

function paintChart(canvas, points, max, end, color) {
  const scale = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  const left = Math.min(85, 16 + number(max).length * 7);
  const plotWidth = width - left - 8;
  const bottom = height - 7;
  const plotHeight = bottom - 7;
  const hour = 3_600_000;
  const start = end - 24 * hour;
  context.font = "11px system-ui";
  context.textBaseline = "middle";
  context.strokeStyle = "#344451";
  context.beginPath();
  for (const ratio of [0, .5, 1]) {
    const y = bottom - ratio * plotHeight;
    context.moveTo(left, y);
    context.lineTo(width, y);
  }
  context.stroke();
  context.fillStyle = "#aab9c5";
  context.fillText(number(max), 1, 7);
  if (max) context.fillText(number(0), 1, bottom);
  context.fillStyle = color;
  for (const [time, value] of points) {
    const position = Math.max(0, (Date.parse(time) - start) / (end - start));
    const x = left + position * plotWidth;
    const bar = Math.max(2, value * plotHeight / Math.max(max, 1));
    context.fillRect(x - 2, bottom - bar, Math.max(3, plotWidth / 37), bar);
  }
}

function renderCharts() {
  const root = byId("charts");
  const charts = [];
  const draws = [];
  for (const key of chartFields) {
    const source = metrics?.[key === "cold_starts" ? "cold_starts" : "requests"];
    const series = source?.data?.[key];
    const node = element("article", null, "card chart");
    node.append(element("h3", t(key)));
    if (!series?.points.length) {
      const detail = source?.error ? t(source.error) : t(source ? "missing_series" : "loading");
      node.append(element("p", source ? t("unavailable") + ". " + detail : detail, "muted empty"));
    } else {
      const last = series.points.at(-1);
      const info = t(series.status, { time: clock(last[0]), value: number(last[1]) });
      const canvas = element("canvas");
      canvas.setAttribute("aria-hidden", "true");
      const max = Math.max(0, ...series.points.map(([, value]) => value));
      const end = Date.parse(series.end_at);
      const axis = element("div", null, "chart-axis");
      axis.append(element("span", dateTime(end - 24 * 3_600_000)), element("span", dateTime(end)));
      const details = element("details");
      details.append(element("summary", t("data_points")),
        table([t("time"), t("value")], series.points.map(([time, value]) => [dateTime(time), number(value)])));
      node.append(element("p", info, "muted chart-meta"), canvas, axis, details);
      const color = key === "failed" || key === "cold_starts" ? "#f6bc75" : "#70ebca";
      draws.push(() => paintChart(canvas, series.points, max, end, color));
    }
    charts.push(node);
  }
  root.replaceChildren(...charts);
  for (const draw of draws) draw();
}

function renderPageData() {
  if (page === "overview") renderCharts();
  if (page === "costs") renderCosts();
}

async function refreshPage() {
  if (page !== "overview" && page !== "costs") return;
  const sequence = ++pageRequest;
  const target = page;
  const keys = target === "overview" ? ["requests", "cold_starts"] : ["today", "week", "month", "balance"];
  let result;
  try {
    result = await request(target === "overview" ? "/api/metrics" : "/api/costs");
  } catch (error) {
    result = Object.fromEntries(keys.map((key) => [key, { error: error.message }]));
  }
  if (sequence !== pageRequest || target !== page) return;
  if (target === "overview") metrics = result;
  else costs = result;
  renderPageData();
}

function showPage() {
  const hash = window.location.hash.slice(1);
  page = pages.includes(hash) ? hash : "overview";
  localNotice = null;
  for (const name of pages) byId(name).hidden = name !== page;
  for (const link of all("[data-page]")) {
    if (link.dataset.page === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  renderState();
  renderPageData();
  void refreshPage();
}

function displayValue(field, value) {
  if (value == null) return t("unavailable");
  if (field === "scaling") return t(value.type) + " · " + (
    value.type === "QUEUE_DELAY" ? number(value.queueDelay) + (lang === "en" ? " s" : " с")
      : number(value.requestCount)
  );
  if (field === "flashboot") return t(value);
  return typeof value === "number" ? number(value) : value;
}

function renderConfirmation() {
  const { diff, rollout_warning, capacity_warning, cancels_timer, estimate } = confirmation.data;
  const rows = diff.map(({ field, old, new: next }) => [
    t(field), displayValue(field, old), displayValue(field, next),
  ]);
  byId("diff").replaceChildren(...(rows.length ? [table([t("field"), t("before"), t("after")], rows)] : []));
  const warnings = [
    rollout_warning && "warning_rollout", capacity_warning && "warning_capacity", cancels_timer && "warning_timer",
  ].filter(Boolean);
  byId("confirm-warnings").replaceChildren(...warnings.map((key) => element("p", t(key), "message warning")));
  renderEstimate(byId("change-estimate"), estimate);
}

async function preview(action, values = {}, formId) {
  const base = formId ? forms[formId].base : state?.endpoint?.data;
  if (!base || operation) return;
  localNotice = null;
  operation = "preview";
  renderState();
  try {
    const draft = { revision: base.revision, action, ...values };
    const data = await request("/api/preview", "POST", draft);
    confirmation = { draft: { ...draft, confirmation: data.confirmation }, data, formId };
    renderConfirmation();
    dialog.showModal();
  } catch (error) {
    localNotice = { status: error.message };
    window.scrollTo(0, 0);
    await refreshState();
  } finally {
    operation = null;
    renderState();
  }
}

function syncForm(id) {
  forms[id].dirty = false;
  forms[id].base = null;
  renderForms();
}

function changedFields(id) {
  const { form, base } = forms[id];
  const values = {};
  const fields = id === "worker-form"
    ? ["active", "max", "idle_timeout"] : ["name", "image", "flashboot", "execution_timeout"];
  for (const key of fields) {
    const input = form.elements[key];
    if (input.disabled || !input.value) continue;
    const value = input.type === "number" ? input.valueAsNumber : input.value;
    if (value !== base[key]) values[key] = value;
  }
  if (id === "settings-form") {
    const type = form.elements.scaling_type.value;
    const key = type === "QUEUE_DELAY" ? "queueDelay" : "requestCount";
    const threshold = form.elements.threshold.valueAsNumber;
    if (type !== base.scaling.type || threshold !== base.scaling[key]) {
      values.scaling = { type, [key]: threshold };
    }
  }
  return values;
}

for (const id of formIds) {
  const entry = forms[id];
  entry.form.addEventListener("input", (event) => {
    entry.dirty = true;
    if (event.target.name === "scaling_type") {
      entry.form.elements.threshold.value = event.target.value === "QUEUE_DELAY"
        ? entry.base.scaling.queueDelay ?? 4 : entry.base.scaling.requestCount ?? 1;
    }
    renderForms();
  });
  entry.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!entry.base) return;
    const values = changedFields(id);
    if (Object.keys(values).length) void preview(id === "worker-form" ? "workers" : "settings", values, id);
    else {
      localNotice = { status: "no_changes" };
      renderState();
      window.scrollTo(0, 0);
    }
  });
}

all("[data-reload]").forEach((button) => button.addEventListener("click", async () => {
  localNotice = null;
  await refreshState();
  syncForm(button.dataset.reload);
}));
all("[data-profile]").forEach((button) => button.addEventListener("click", () => {
  void preview("profile", { profile: button.dataset.profile });
}));
byId("warm").addEventListener("click", () => { void preview("warm"); });
byId("cancel").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => { confirmation = null; });
byId("apply").addEventListener("click", async () => {
  if (!confirmation || operation) return;
  const { draft, formId } = confirmation;
  operation = "apply";
  dialog.close();
  renderState();
  window.scrollTo(0, 0);
  try {
    const result = await request("/api/apply", "POST", draft);
    await refreshState();
    localNotice = result.status === "write_pending" ? result : null;
    if (formId && ["applied", "timer_cancelled"].includes(result.status)) syncForm(formId);
  } catch (error) {
    localNotice = { status: error.message };
    await refreshState();
  } finally {
    operation = null;
    renderState();
  }
});

byId("review").addEventListener("click", async () => {
  if (operation) return;
  operation = "review";
  renderState();
  try {
    localNotice = await request("/api/review", "POST");
  } catch (error) {
    localNotice = { status: error.message };
  } finally {
    operation = null;
    await refreshState();
  }
});
byId("probe").addEventListener("click", async () => {
  probeVersion += 1;
  probeResult = { status: "probe_running" };
  renderProbe();
  try {
    probeResult = await request("/api/probe", "POST");
  } catch (error) {
    probeResult = { status: error.message };
  }
  renderProbe();
});
byId("refresh").addEventListener("click", () => {
  localNotice = null;
  void refreshState();
  void refreshPage();
});
byId("billing-period").addEventListener("change", renderCosts);
all("[data-lang]").forEach((button) => button.addEventListener("click", () => {
  lang = button.dataset.lang;
  localStorage.setItem("runpod-panel-language", lang);
  applyLanguage();
}));
window.addEventListener("hashchange", showPage);
window.addEventListener("resize", () => {
  if (page === "overview") renderCharts();
});
setInterval(() => {
  if (document.hidden) return;
  if (localNotice?.status === "write_pending") localNotice = null;
  void refreshState();
}, 15000);
setInterval(() => {
  if (probePending.has(probeResult?.status)) void refreshProbe();
}, 2500);
setInterval(() => {
  if (!document.hidden && page === "overview") void refreshPage();
}, 60000);

applyLanguage();
showPage();
void refreshState();
void refreshProbe();
