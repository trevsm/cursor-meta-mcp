const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

const fmtHeaderRefresh = (iso) => {
  if (!iso) return "Last refreshed —";
  const date = new Date(iso);
  return `Last refreshed ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })} • ${date.toLocaleDateString()}`;
};

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

const WORKSPACE_STORAGE_KEY = "cursor-meta-dashboard-workspaceId";

let fullData = null;
let lastLiveAt = null;
let primaryAction = { path: "/api/start", label: "Start fleet", mode: "start" };
const workerCardOpen = new Map();
let selectedWorkspaceId = localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "";
let workspaceCatalog = [];

function apiQuery() {
  if (!selectedWorkspaceId) return "";
  return `?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`;
}

function workspaceOptionLabel(row) {
  const status = row.running ? " ● running" : "";
  const workers = row.aliveCount > 0 ? ` · ${row.aliveCount} up` : "";
  return `${row.label}${status}${workers}`;
}

const LUCIDE_OPTS = { attrs: { "stroke-width": 1.75 } };

function lucideApi() {
  return globalThis.lucide;
}

function initLucideIcons(root = document) {
  const api = lucideApi();
  if (!api?.createIcons) return false;
  api.createIcons({ ...LUCIDE_OPTS, root });
  return true;
}

function whenLucideReady(run) {
  if (initLucideIcons(document.querySelector(".app-header"))) {
    run();
    return;
  }
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (initLucideIcons(document.querySelector(".app-header")) || attempts > 100) {
      clearInterval(timer);
      run();
    }
  }, 50);
}

function setLucideIcon(host, name) {
  if (!host || !name) return;
  const api = lucideApi();
  if (!api?.createIcons) return;
  host.replaceChildren();
  const icon = document.createElement("i");
  icon.dataset.lucide = name;
  host.appendChild(icon);
  api.createIcons({ ...LUCIDE_OPTS, root: host });
}

function closeHeaderMenu() {
  const menu = document.getElementById("header-menu");
  const toggle = document.getElementById("header-menu-toggle");
  if (!menu || !toggle) return;
  menu.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
}

function openHeaderMenu() {
  const menu = document.getElementById("header-menu");
  const toggle = document.getElementById("header-menu-toggle");
  if (!menu || !toggle) return;
  menu.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
}

function toggleHeaderMenu() {
  const menu = document.getElementById("header-menu");
  if (!menu) return;
  if (menu.hidden) openHeaderMenu();
  else closeHeaderMenu();
}

function fleetRunningFromHealth(fh) {
  return (
    (fh?.alive ?? 0) > 0 || fh?.watcherAlive === true || fh?.strategyReviewerAlive === true
  );
}

function resolvePrimaryAction(data) {
  const fh = data?.fleetHealth ?? {};
  const fc = data?.fleetControl ?? {};
  const running = fleetRunningFromHealth(fh);
  if (running) return { path: "/api/stop", label: "Stop fleet", mode: "stop" };
  if (fc.canResume) return { path: "/api/resume", label: "Resume fleet", mode: "resume" };
  return { path: "/api/start", label: "Start fleet", mode: "start" };
}

function formatFleetRoleSummary(fh) {
  const coders = fh.codersAlive ?? 0;
  const supervisors = fh.supervisorsAlive ?? 0;
  const coderLabel = coders === 1 ? "coder" : "coders";
  const supervisorLabel = supervisors === 1 ? "supervisor" : "supervisors";
  return `${coders} ${coderLabel} · ${supervisors} ${supervisorLabel}`;
}

function updateHeader(data) {
  const fh = data?.fleetHealth ?? {};
  const fc = data?.fleetControl ?? {};
  const running = fleetRunningFromHealth(fh);
  const workerCount = fh.alive ?? 0;

  document.getElementById("header-path").textContent =
    data?.manifest?.root ?? data?.metaDir ?? "—";
  document.getElementById("header-refreshed").textContent = fmtHeaderRefresh(data?.at);

  const ring = document.getElementById("header-status-ring");
  const statusLabel = document.getElementById("header-status-label");
  const workerLine = document.getElementById("header-worker-count");

  let statusText = "Idle";
  let ringClass = "idle";
  let ringIcon = "circle";
  if (running) {
    if ((fh.total ?? 0) > 0 && workerCount < fh.total) {
      statusText = "Degraded";
      ringClass = "degraded";
      ringIcon = "circle-alert";
    } else {
      statusText = "Running";
      ringClass = "running";
      ringIcon = "circle-check";
    }
  }
  ring.className = `status-ring ${ringClass}`;
  setLucideIcon(ring, ringIcon);
  statusLabel.textContent = statusText;
  workerLine.textContent = formatFleetRoleSummary(fh);

  const budgetStatus = data?.budget?.status ?? "ok";
  const pillEl = document.getElementById("budget-pill");
  const pillText = document.getElementById("budget-pill-text");
  pillEl.className = `budget-badge ${budgetStatus}`;
  pillText.textContent =
    budgetStatus === "blocked" ? "BUDGET BLOCKED" : budgetStatus === "warn" ? "BUDGET WARN" : "BUDGET OK";
  setLucideIcon(
    document.getElementById("budget-pill-icon"),
    budgetStatus === "blocked" ? "circle-x" : budgetStatus === "warn" ? "circle-alert" : "circle-check",
  );

  primaryAction = resolvePrimaryAction(data);
  const primaryBtn = document.getElementById("fleet-primary");
  const primaryLabel = document.getElementById("fleet-primary-label");
  primaryLabel.textContent = primaryAction.label;
  primaryBtn.classList.toggle("stop", primaryAction.mode === "stop");
  primaryBtn.disabled = false;
  setLucideIcon(
    document.getElementById("fleet-primary-icon"),
    primaryAction.mode === "stop" ? "square" : "play",
  );

  const menuStart = document.getElementById("menu-start");
  const menuStop = document.getElementById("menu-stop");
  const menuResume = document.getElementById("menu-resume");
  if (menuStart) menuStart.disabled = running || primaryAction.mode === "start";
  if (menuStop) menuStop.disabled = !running || primaryAction.mode === "stop";
  if (menuResume) {
    menuResume.disabled = running || !fc.canResume || primaryAction.mode === "resume";
    menuResume.title = fc.canResume
      ? `Continue from tick ${fc.resumeTickCount ?? 0}${
          fc.resumeStoppedBecause ? ` (${fc.resumeStoppedBecause})` : ""
        }`
      : "No checkpoint to resume";
  }
}

async function loadLog(name) {
  if (!name) return;
  const res = await fetch(`/api/logs/${encodeURIComponent(name)}${apiQuery()}`);
  document.getElementById("log-view").textContent = await res.text();
}

async function loadWorkspaces() {
  const res = await fetch("/api/workspaces");
  const body = await res.json();
  workspaceCatalog = body.workspaces ?? [];

  const stored = localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "";
  const preferred =
    (stored && workspaceCatalog.some((row) => row.id === stored) && stored) ||
    (body.defaultWorkspaceId &&
      workspaceCatalog.some((row) => row.id === body.defaultWorkspaceId) &&
      body.defaultWorkspaceId) ||
    workspaceCatalog.find((row) => row.running)?.id ||
    workspaceCatalog[0]?.id ||
    "";

  selectedWorkspaceId = preferred;
  if (selectedWorkspaceId) {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, selectedWorkspaceId);
  }
  renderWorkspaceSelect();
}

function renderWorkspaceSelect() {
  const select = document.getElementById("workspace-select");
  if (!select) return;
  if (!workspaceCatalog.length) {
    select.innerHTML = '<option value="">No fleet workspaces found</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = workspaceCatalog
    .map(
      (row) =>
        `<option value="${escapeHtml(row.id)}"${row.id === selectedWorkspaceId ? " selected" : ""}>${escapeHtml(workspaceOptionLabel(row))}</option>`,
    )
    .join("");
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
            ${pill(!worker.alive ? "dead" : worker.status === "active" ? "alive" : worker.status === "error" ? "bad" : "ok")}
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

function renderWhyOverview(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return '<span class="why-empty">Why the fleet is doing what it\'s doing will appear here…</span>';

  const segments = raw.split(/(?=Why [^:]+:)/).map((part) => part.trim()).filter(Boolean);
  if (segments.length <= 1 && !/^Why /i.test(raw)) {
    return `<p class="why-plain">${escapeHtml(raw)}</p>`;
  }

  const rows = segments.map((segment) => {
    const labeled = segment.match(/^(Why [^:]+:)\s*(.*)$/s);
    if (labeled) {
      return `<div class="why-row"><span class="why-label">${escapeHtml(labeled[1])}</span><span class="why-text">${escapeHtml(labeled[2])}</span></div>`;
    }
    return `<div class="why-row why-row-plain"><span class="why-text">${escapeHtml(segment)}</span></div>`;
  });

  return `<div class="why-rows">${rows.join("")}</div>`;
}

function renderLive(data) {
  lastLiveAt = data.at;
  const summary = data.activeSummary ?? {};
  document.getElementById("summary-headline").textContent = summary.headline ?? "Standing by";
  document.getElementById("fleet-overview").innerHTML = renderWhyOverview(
    summary.overview ?? "",
  );
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
  void overviewStatus;

  if (fullData) {
    updateHeader({ ...fullData, fleetHealth: data.fleetHealth, at: data.at ?? fullData.at });
  }
}

function renderFull(data) {
  fullData = data;
  updateHeader(data);

  const fh = data.fleetHealth ?? {};
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
    const paused = rt.running === false;
    document.getElementById("runtime-label").textContent = paused
      ? `${fmtDuration(rt.elapsedMs)} elapsed · paused · ${fmtDuration(rt.remainingMs)} left`
      : `${fmtDuration(rt.elapsedMs)} elapsed · ${fmtDuration(rt.remainingMs)} left`;
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
    const res = await fetch(`/api/live${apiQuery()}`);
    renderLive(await res.json());
  } catch (error) {
    document.getElementById("summary-meta").textContent = `Live update failed: ${error.message ?? error}`;
  }
}

async function refreshFull() {
  const res = await fetch(`/api/status${apiQuery()}`);
  renderFull(await res.json());
  try {
    const wsRes = await fetch("/api/workspaces");
    const body = await wsRes.json();
    workspaceCatalog = body.workspaces ?? [];
    renderWorkspaceSelect();
  } catch {
    /* workspace list refresh is best-effort */
  }
}

async function refreshAll() {
  await Promise.all([refreshLive(), refreshFull()]);
}

let resetArmed = false;
let resetArmTimer = null;

function disarmResetButton(btn) {
  resetArmed = false;
  if (resetArmTimer) clearTimeout(resetArmTimer);
  resetArmTimer = null;
  btn.textContent = "Reset all";
  btn.classList.remove("armed");
}

async function resetDashboard() {
  closeHeaderMenu();
  const btn = document.getElementById("reset");
  if (!btn) return;

  if (!resetArmed) {
    resetArmed = true;
    btn.textContent = "Confirm reset all";
    btn.classList.add("armed");
    resetArmTimer = setTimeout(() => disarmResetButton(btn), 5000);
    document.getElementById("summary-meta").textContent =
      "Click Confirm reset all within 5s to wipe fleet logs, checkpoints, and budget clock.";
    return;
  }

  disarmResetButton(btn);
  btn.disabled = true;
  btn.textContent = "Resetting…";
  try {
    const res = await fetch(`/api/reset${apiQuery()}`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Reset failed (${res.status})`);
    document.getElementById("summary-meta").textContent =
      `Reset complete — removed ${body.removedFiles?.length ?? 0} file(s).`;
    await refreshAll();
  } catch (error) {
    document.getElementById("summary-meta").textContent = `Reset failed: ${error.message ?? error}`;
    alert(error.message ?? String(error));
  } finally {
    btn.disabled = false;
    btn.textContent = "Reset all";
  }
}

async function resetFleetRuntime() {
  closeHeaderMenu();
  const btn = document.getElementById("reset-runtime");
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = "Resetting…";
  try {
    const res = await fetch(`/api/reset-runtime${apiQuery()}`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Reset clock failed (${res.status})`);
    document.getElementById("summary-meta").textContent = "Runtime clock reset — checkpoints and logs unchanged.";
    await refreshAll();
  } catch (error) {
    document.getElementById("summary-meta").textContent = `Reset clock failed: ${error.message ?? error}`;
    alert(error.message ?? String(error));
  } finally {
    btn.disabled = false;
    btn.textContent = "Reset clock";
  }
}

async function postFleetAction(path, busyLabel, triggerBtn) {
  closeHeaderMenu();
  const labels = {
    "/api/start": "Start fleet",
    "/api/stop": "Stop fleet",
    "/api/resume": "Resume fleet",
  };
  const defaultLabel = labels[path] ?? "Run";
  const btn = triggerBtn ?? document.getElementById("fleet-primary");
  const labelEl = document.getElementById("fleet-primary-label");
  const previousLabel = labelEl?.textContent ?? defaultLabel;
  if (btn) {
    btn.disabled = true;
    if (labelEl) labelEl.textContent = busyLabel;
  }
  try {
    const res = await fetch(`${path}${apiQuery()}`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `${defaultLabel} failed (${res.status})`);
    document.getElementById("summary-meta").textContent = `${defaultLabel} complete.`;
    await refreshAll();
  } catch (error) {
    document.getElementById("summary-meta").textContent = `${defaultLabel} failed: ${error.message ?? error}`;
    alert(error.message ?? String(error));
  } finally {
    if (btn) btn.disabled = false;
    if (fullData) updateHeader(fullData);
    else if (labelEl) labelEl.textContent = previousLabel;
  }
}

document.getElementById("refresh").addEventListener("click", refreshAll);
document.getElementById("reset").addEventListener("click", resetDashboard);
document.getElementById("reset-runtime").addEventListener("click", resetFleetRuntime);
document.getElementById("fleet-primary").addEventListener("click", () => {
  const busy =
    primaryAction.mode === "stop"
      ? "Stopping…"
      : primaryAction.mode === "resume"
        ? "Resuming…"
        : "Starting…";
  postFleetAction(primaryAction.path, busy);
});
document.getElementById("menu-start").addEventListener("click", () =>
  postFleetAction("/api/start", "Starting…"),
);
document.getElementById("menu-stop").addEventListener("click", () =>
  postFleetAction("/api/stop", "Stopping…"),
);
document.getElementById("menu-resume").addEventListener("click", () =>
  postFleetAction("/api/resume", "Resuming…"),
);
document.getElementById("header-menu-toggle").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleHeaderMenu();
});
document.addEventListener("click", (event) => {
  const wrap = document.querySelector(".menu-wrap");
  if (!wrap || wrap.contains(event.target)) return;
  closeHeaderMenu();
});
document.getElementById("log-select").addEventListener("change", (e) => loadLog(e.target.value));
document.getElementById("workspace-select").addEventListener("change", async (event) => {
  selectedWorkspaceId = event.target.value;
  if (selectedWorkspaceId) {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, selectedWorkspaceId);
  } else {
    localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  }
  workerCardOpen.clear();
  await refreshAll();
});

whenLucideReady(async () => {
  await loadWorkspaces();
  await refreshAll();
});
setInterval(refreshLive, 2000);
setInterval(refreshFull, 8000);
