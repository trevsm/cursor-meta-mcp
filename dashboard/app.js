const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

const fmtDuration = (ms) => {
  if (ms == null || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

const pill = (status) => {
  const cls =
    status === "alive" || status === "ok"
      ? status === "alive"
        ? "alive"
        : "ok"
      : status === "warn"
        ? "warn"
        : status === "dead" || status === "bad"
          ? "dead"
          : "warn";
  return `<span class="pill ${cls}">${status}</span>`;
};

const badge = (kind) => `<span class="badge ${kind}">${kind}</span>`;

let fullData = null;
let lastLiveAt = null;
const workerCardOpen = new Map();

async function loadLog(name) {
  if (!name) return;
  const res = await fetch(`/api/logs/${encodeURIComponent(name)}`);
  document.getElementById("log-view").textContent = await res.text();
}

function fleetState(fh) {
  if (!fh?.total) return "warn";
  if (fh.alive === 0) return "bad";
  if (fh.alive < fh.total) return "warn";
  return "ok";
}

function renderWorkerActivity(rows) {
  const el = document.getElementById("worker-activity");
  for (const detail of el.querySelectorAll("details.worker-card")) {
    if (detail.dataset.worker) workerCardOpen.set(detail.dataset.worker, detail.open);
  }
  if (!rows?.length) {
    el.innerHTML = '<div class="empty">No workers in manifest</div>';
    return;
  }
  el.innerHTML = rows
    .map((worker) => {
      const ticks = (worker.recentTicks ?? [])
        .map(
          (tick) => `<div class="tick-row">
            <div class="tick-row-head">
              <span>Tick ${tick.tick}${tick.producedWork ? " · shipped" : tick.error ? " · failed" : ""}</span>
              <span>${tick.durationMs != null ? fmtDuration(tick.durationMs) : ""}</span>
            </div>
            <div class="tick-row-meta">${escapeHtml(tick.outcomeSummary ?? tick.error ?? "—")}</div>
            ${tick.workSummary ? `<div class="tick-row-work">${escapeHtml(tick.workSummary)}</div>` : ""}
          </div>`,
        )
        .join("");
      const events = (worker.liveEvents ?? [])
        .slice(0, 6)
        .map(
          (event) => `<div class="live-event">
            <span class="live-event-kind">${escapeHtml(event.kind)}</span>
            <span class="live-event-text">${escapeHtml(event.text)}</span>
          </div>`,
        )
        .join("");
      const stats = [
        worker.ticksCompleted ? `${worker.ticksCompleted} ticks` : "",
        worker.productiveRatio != null
          ? `${(worker.productiveRatio * 100).toFixed(0)}% productive`
          : "",
      ]
        .filter(Boolean)
        .map((s) => `<span class="stat-chip">${escapeHtml(s)}</span>`)
        .join("");
      const tickCount = worker.recentTicks?.length ?? 0;
      const detailHint =
        tickCount > 0
          ? `${tickCount} recent tick${tickCount === 1 ? "" : "s"}${events ? " · live stream" : ""}`
          : events
            ? "Live stream"
            : "";
      const defaultOpen = false;
      const open = workerCardOpen.has(worker.name) ? workerCardOpen.get(worker.name) : defaultOpen;
      const body =
        ticks || events
          ? `<div class="worker-body">
              ${ticks ? `<div class="tick-list">${ticks}</div>` : ""}
              ${events ? `<div class="live-events"><h4>Live stream</h4>${events}</div>` : ""}
            </div>`
          : "";
      return `<details class="worker-card ${worker.status}" data-worker="${escapeHtml(worker.name)}"${
        open ? " open" : ""
      }>
        <summary class="worker-summary">
          <div class="worker-head">
            <div class="worker-head-main">
              <span class="worker-chevron" aria-hidden="true"></span>
              <div>
                <div class="worker-title">${escapeHtml(worker.displayName)}</div>
                <div class="worker-role">${escapeHtml(worker.role)}</div>
              </div>
            </div>
            ${pill(worker.status === "active" ? "alive" : worker.status === "error" ? "bad" : worker.alive ? "ok" : "dead")}
          </div>
          <div class="worker-status">${escapeHtml(worker.statusText)}</div>
          ${stats ? `<div class="worker-stats">${stats}</div>` : ""}
          ${detailHint ? `<div class="worker-expand-hint">${escapeHtml(detailHint)}</div>` : ""}
        </summary>
        ${body}
      </details>`;
    })
    .join("");
}

function renderLive(data) {
  lastLiveAt = data.at;
  const summary = data.activeSummary ?? {};
  document.getElementById("summary-headline").textContent = summary.headline ?? "Standing by";
  document.getElementById("fleet-overview").textContent =
    summary.overview ?? "Waiting for fleet status…";
  document.getElementById("summary-meta").textContent =
    `Updated ${fmtTime(summary.at ?? data.at)} · ${data.liveChatCount ?? 0} live chats`;

  const linesEl = document.getElementById("summary-lines");
  const lines = summary.lines ?? [];
  linesEl.innerHTML = lines.length
    ? lines
        .map(
          (line) =>
            `<div class="summary-line ${line.level}"><span class="dot"></span><span>${escapeHtml(line.text)}</span></div>`,
        )
        .join("")
    : '<div class="empty">No activity summary yet</div>';

  const thoughts = data.spawnThoughts ?? [];
  document.getElementById("thought-count").textContent = String(thoughts.length);
  renderWorkerActivity(data.workerActivity ?? []);
  const feed = document.getElementById("thought-feed");
  feed.innerHTML = thoughts.length
    ? thoughts
        .map((thought) => {
          const statusBadge = pill(thought.status);
          const kindBadge = thought.kind !== "other" ? badge(thought.kind) : "";
          const sourceBadge = `<span class="badge">${thought.source}</span>`;
          return `<article class="thought-card ${thought.status}">
            <div class="thought-top">
              <div class="thought-label">${escapeHtml(thought.label)}</div>
              <div class="thought-badges">${statusBadge}${kindBadge}${sourceBadge}</div>
            </div>
            <div class="thought-text">${escapeHtml(thought.text)}</div>
            ${thought.at ? `<div class="thought-time">${fmtTime(thought.at)}</div>` : ""}
          </article>`;
        })
        .join("")
    : '<div class="empty">No spawn thoughts yet — workers and SDK runs will appear here</div>';

  const state = fleetState(data.fleetHealth);
  const overviewStatus = summary.status ?? state;
  document.getElementById("brand-dot").className = `brand-dot ${overviewStatus === "idle" ? state : overviewStatus}`;
}

function renderFull(data) {
  fullData = data;
  document.getElementById("updated").textContent =
    `Full refresh ${fmtTime(data.at)} · ${data.manifest?.root ?? data.metaDir}`;

  const budgetStatus = data.budget?.status ?? "ok";
  const pillEl = document.getElementById("budget-pill");
  pillEl.className = `pill ${budgetStatus}`;
  pillEl.textContent = `budget ${budgetStatus}`;

  const fh = data.fleetHealth ?? {};
  const state = fleetState(fh);
  const fleetLabel = `${fh.alive} / ${fh.total} alive`;
  const healthBits = [
    fh.watcherAlive ? "watcher ✓" : "watcher ✗",
    fh.strategyReviewerAlive ? "strategy ✓" : "strategy ✗",
  ].join(" · ");

  let title = "Fleet healthy";
  if (!fh.total) title = "No fleet running";
  else if (fh.alive === 0) title = "Fleet stopped";
  else if (fh.alive < fh.total) title = "Fleet degraded";

  document.getElementById("fleet-status").innerHTML = `${title}<div class="proc-meta">${fleetLabel} · ${healthBits}</div>`;

  const rt = data.fleetRuntime;
  const rtWrap = document.getElementById("runtime-wrap");
  if (rt?.maxDurationMs > 0) {
    rtWrap.hidden = false;
    document.getElementById("runtime-fill").style.width = `${rt.percent.toFixed(1)}%`;
    document.getElementById("runtime-label").textContent =
      `${fmtDuration(rt.elapsedMs)} elapsed · ${fmtDuration(rt.remainingMs)} left`;
  } else {
    rtWrap.hidden = true;
  }

  const gs = data.gitSync ?? {};
  const blocked = data.manifest?.budgetBlocked ? "YES" : "no";
  const spawns = data.budget?.local?.spawnsLastHour ?? 0;
  const cents = data.budget?.local?.estimatedCents ?? 0;
  const ticks = data.budget?.local?.ideTicks ?? 0;
  const planPct = data.budget?.plan?.percent;
  const fleetPct = data.budget?.fleet?.percentOfMaxDuration;
  const prod = data.fleetProductivity;
  const attempted = prod?.attemptedTicks ?? prod?.totalTicks ?? 0;
  const prodLabel =
    prod && attempted > 0
      ? `${(prod.productiveRatio * 100).toFixed(0)}% (${prod.productiveTicks}/${attempted})`
      : "—";

  document.getElementById("metrics").innerHTML = [
    metric("Spend", `$${(cents / 100).toFixed(2)}`, data.budget?.warnings?.[0] ?? ""),
    metric("Spawns/hr", String(spawns), `cap ${data.budget?.limits?.maxSpawnsPerHour ?? "?"}`),
    metric("IDE ticks", String(ticks)),
    metric("Productive", prodLabel, prod ? `gate ${prod.gatePercent}% · attempted` : ""),
    metric("Git", gs.dirty ? "dirty" : gs.unpushed ? "unpushed" : "clean", gs.branch || "?"),
    metric("Plan", planPct != null ? `${planPct.toFixed(1)}%` : "—"),
    metric("Blocked", blocked, data.manifest?.budgetBlockedReason ?? ""),
    metric("Fleet budget", fleetPct != null ? `${fleetPct.toFixed(1)}%` : "—"),
  ].join("");

  document.getElementById("processes").innerHTML =
    (data.experiments ?? [])
      .map((exp) => {
        const cp = exp.checkpoint ?? {};
        const last = cp.lastTick;
        const attempted =
          cp.attemptedTicks ??
          (cp.metrics != null
            ? Math.max(0, (cp.metrics.ticks ?? 0) - (cp.metrics.softSkips ?? 0))
            : cp.ticks);
        const notes = [
          exp.relaunchCount ? `relaunch ×${exp.relaunchCount}` : "",
          cp.stoppedBecause ? `stopped: ${cp.stoppedBecause}` : "",
          cp.productiveRatio != null && attempted
            ? `productive ${(cp.productiveRatio * 100).toFixed(0)}% (${cp.productiveTicks ?? 0}/${attempted})`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return `<div class="proc">
          <div class="proc-dot ${exp.alive ? "alive" : ""}"></div>
          <div>
            <div class="proc-name">${escapeHtml(exp.displayName ?? exp.name)}</div>
            <div class="proc-meta">pid ${exp.pid > 0 ? exp.pid : "—"} · ticks ${cp.ticks ?? "—"} · ${last?.at ? fmtTime(last.at) : "idle"}</div>
            ${notes ? `<div class="proc-meta">${escapeHtml(notes)}</div>` : ""}
          </div>
          ${exp.alive ? pill("alive") : pill("dead")}
        </div>`;
      })
      .join("") || '<div class="muted">No fleet manifest</div>';

  const pulse = data.pulse?.error ? null : data.pulse;
  const live = pulse?.live ?? [];
  document.getElementById("live-chats").innerHTML = live.length
    ? live
        .map(
          (c) =>
            `<li><strong>#${c.sessionIndex ?? "?"} ${escapeHtml(c.title)}</strong> — ${escapeHtml(c.signals.join(", ") || "idle")}</li>`,
        )
        .join("")
    : '<li class="muted">No in-flight chats</li>';

  const strat = data.strategyStatus ?? {};
  document.getElementById("strategy").innerHTML =
    strat.onTrack != null
      ? `<div>${strat.onTrack ? pill("ok") : pill("warn")} score ${strat.score ?? "?"}</div>
         <p class="muted">${escapeHtml(strat.recommendation ?? "")}</p>
         <p class="muted">At ${fmtTime(strat.at)}</p>`
      : '<p class="muted">No strategy review yet</p>';

  const fr = pulse?.frustrationEvents ?? [];
  document.getElementById("frustration").innerHTML = fr.length
    ? fr
        .slice(0, 8)
        .map(
          (e) =>
            `<li>#${e.sessionIndex ?? "?"} ${escapeHtml(e.title)}: ${escapeHtml(e.frustrationRisk?.reason ?? "risk")}</li>`,
        )
        .join("")
    : '<li class="muted">None flagged</li>';

  const sel = document.getElementById("log-select");
  const prev = sel.value;
  sel.innerHTML = (data.logs ?? [])
    .map((l) => `<option value="${escapeHtml(l.name)}">${escapeHtml(l.name)} (${Math.round(l.bytes / 1024)}kb)</option>`)
    .join("");
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else if (sel.options.length) sel.value = sel.options[0].value;
  loadLog(sel.value);
}

function metric(label, value, hint = "") {
  return `<div class="metric">
    <div class="metric-label">${escapeHtml(label)}</div>
    <div class="metric-value">${escapeHtml(value)}</div>
    ${hint ? `<div class="metric-hint">${escapeHtml(hint)}</div>` : ""}
  </div>`;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function refreshLive() {
  try {
    const res = await fetch("/api/live");
    renderLive(await res.json());
  } catch (error) {
    document.getElementById("summary-meta").textContent = `Live update failed: ${error.message ?? error}`;
  }
}

async function refreshFull() {
  const res = await fetch("/api/status");
  renderFull(await res.json());
}

async function refreshAll() {
  await Promise.all([refreshLive(), refreshFull()]);
}

async function relaunchFleet() {
  const btn = document.getElementById("relaunch");
  btn.disabled = true;
  btn.textContent = "Launching…";
  try {
    const res = await fetch("/api/relaunch", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "Launch failed");
    await refreshAll();
  } catch (error) {
    alert(error.message ?? String(error));
  } finally {
    btn.disabled = false;
    btn.textContent = "Relaunch fleet";
  }
}

document.getElementById("refresh").addEventListener("click", refreshAll);
document.getElementById("relaunch").addEventListener("click", relaunchFleet);
document.getElementById("log-select").addEventListener("change", (e) => loadLog(e.target.value));

refreshAll();
setInterval(refreshLive, 2000);
setInterval(refreshFull, 8000);
