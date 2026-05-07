// Settings window — tabbed UI: Settings (existing) + Activity (Phase 11B).
// All IPC follows the same invoke pattern established in Phase 9.

// ── Types ────────────────────────────────────────────────────────────────────

interface PetManifest {
  id: string;
  displayName: string;
  description: string;
}

interface WebhookOutboundConfig {
  enabled: boolean;
  urls: string[];
  bearerToken?: string;
  eventFilter: {
    stateChanges: boolean;
    bubbles: boolean;
    errors: boolean;
  };
}

interface AppConfig {
  selectedPetId: string | null;
  codexBridgeEnabled?: boolean;
  overlayScale?: number;
  displayScales?: Record<string, number>;
  displayPositions?: Record<string, { x: number; y: number }>;
  idleWanderEnabled?: boolean;
  idleWanderDelayMs?: number;
  idleWanderSpeedPxPerSec?: number;
  bubbleEnabled?: boolean;
  bubbleLifetimeMs?: number;
  bubbleMaxStack?: number;
  webhookOutbound?: WebhookOutboundConfig;
}

interface ActivityLogEntry {
  ts: string;
  session_id: string;
  type: string;
  data: Record<string, unknown>;
}

declare global {
  interface Window {
    ash: {
      listPets: () => Promise<PetManifest[]>;
      getSettings: () => Promise<AppConfig>;
      saveSettings: (partial: Partial<AppConfig>) => Promise<AppConfig>;
      getCurrentDisplayId: () => Promise<string | null>;
      getOpenAtLogin: () => Promise<boolean>;
      setOpenAtLogin: (v: boolean) => Promise<boolean>;
      // Phase 11B
      readActivityLog: () => Promise<ActivityLogEntry[]>;
      readCrashLog: () => Promise<unknown[]>;
      clearActivityLog: () => Promise<{ ok: boolean }>;
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ── Settings tab elements ────────────────────────────────────────────────────

const els = {
  petSelect:           $<HTMLSelectElement>("pet-select"),
  displayId:           $<HTMLSpanElement>("display-id"),
  scale:               $<HTMLInputElement>("scale"),
  scaleValue:          $<HTMLSpanElement>("scale-value"),
  wanderEnabled:       $<HTMLInputElement>("wander-enabled"),
  wanderDelay:         $<HTMLInputElement>("wander-delay"),
  wanderDelayValue:    $<HTMLSpanElement>("wander-delay-value"),
  wanderSpeed:         $<HTMLInputElement>("wander-speed"),
  wanderSpeedValue:    $<HTMLSpanElement>("wander-speed-value"),
  bubbleEnabled:       $<HTMLInputElement>("bubble-enabled"),
  bubbleLifetime:      $<HTMLInputElement>("bubble-lifetime"),
  bubbleLifetimeValue: $<HTMLSpanElement>("bubble-lifetime-value"),
  bubbleStack:         $<HTMLInputElement>("bubble-stack"),
  bubbleStackValue:    $<HTMLSpanElement>("bubble-stack-value"),
  codexEnabled:        $<HTMLInputElement>("codex-enabled"),
  // Phase 12A — webhook outbound
  webhookEnabled:      $<HTMLInputElement>("webhook-enabled"),
  webhookUrls:         $<HTMLTextAreaElement>("webhook-urls"),
  webhookToken:        $<HTMLInputElement>("webhook-token"),
  whFilterState:       $<HTMLInputElement>("wh-filter-state"),
  whFilterBubble:      $<HTMLInputElement>("wh-filter-bubble"),
  whFilterError:       $<HTMLInputElement>("wh-filter-error"),
  loginEnabled:        $<HTMLInputElement>("login-enabled"),
  btnCancel:           $<HTMLButtonElement>("btn-cancel"),
  btnApply:            $<HTMLButtonElement>("btn-apply"),
  status:              $<HTMLParagraphElement>("status"),
};

let currentDisplayId: string | null = null;

function bindRangeLabel(input: HTMLInputElement, label: HTMLSpanElement, fmt: (v: number) => string): void {
  const update = () => { label.textContent = fmt(parseFloat(input.value)); };
  input.addEventListener("input", update);
  update();
}

async function loadAll(): Promise<void> {
  const [pets, cfg, displayId, openAtLogin] = await Promise.all([
    window.ash.listPets(),
    window.ash.getSettings(),
    window.ash.getCurrentDisplayId(),
    window.ash.getOpenAtLogin(),
  ]);

  currentDisplayId = displayId;
  els.displayId.textContent = displayId ?? "no overlay";

  els.petSelect.innerHTML = "";
  for (const pet of pets) {
    const opt = document.createElement("option");
    opt.value = pet.id;
    opt.textContent = pet.displayName;
    els.petSelect.appendChild(opt);
  }
  if (cfg.selectedPetId) els.petSelect.value = cfg.selectedPetId;

  const displayScale = (displayId && cfg.displayScales?.[displayId])
    ?? cfg.overlayScale
    ?? 1.5;
  els.scale.value = String(displayScale);

  els.wanderEnabled.checked  = cfg.idleWanderEnabled !== false;
  els.wanderDelay.value      = String(Math.round((cfg.idleWanderDelayMs ?? 60000) / 1000));
  els.wanderSpeed.value      = String(cfg.idleWanderSpeedPxPerSec ?? 150);

  els.bubbleEnabled.checked  = cfg.bubbleEnabled !== false;
  els.bubbleLifetime.value   = String(Math.round((cfg.bubbleLifetimeMs ?? 10000) / 1000));
  els.bubbleStack.value      = String(cfg.bubbleMaxStack ?? 5);

  els.codexEnabled.checked   = cfg.codexBridgeEnabled === true;

  // Phase 12A — webhook outbound
  const wh = cfg.webhookOutbound;
  els.webhookEnabled.checked  = wh?.enabled === true;
  els.webhookUrls.value       = (wh?.urls ?? []).join("\n");
  els.webhookToken.value      = wh?.bearerToken ?? "";
  els.whFilterState.checked   = wh?.eventFilter?.stateChanges !== false;
  els.whFilterBubble.checked  = wh?.eventFilter?.bubbles === true;
  els.whFilterError.checked   = wh?.eventFilter?.errors !== false;

  els.loginEnabled.checked   = openAtLogin;

  bindRangeLabel(els.scale,          els.scaleValue,          v => `${v.toFixed(2)}×`);
  bindRangeLabel(els.wanderDelay,    els.wanderDelayValue,    v => `${v}s`);
  bindRangeLabel(els.wanderSpeed,    els.wanderSpeedValue,    v => `${v} px/s`);
  bindRangeLabel(els.bubbleLifetime, els.bubbleLifetimeValue, v => `${v}s`);
  bindRangeLabel(els.bubbleStack,    els.bubbleStackValue,    v => `${v}`);
}

async function applyChanges(): Promise<void> {
  els.status.textContent = "Saving…";
  els.status.style.color = "#888";

  // Parse webhook URLs: split on newlines, trim each, drop blanks.
  const webhookUrls = els.webhookUrls.value
    .split("\n")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  const partial: Partial<AppConfig> = {
    selectedPetId: els.petSelect.value || null,
    idleWanderEnabled: els.wanderEnabled.checked,
    idleWanderDelayMs: parseInt(els.wanderDelay.value, 10) * 1000,
    idleWanderSpeedPxPerSec: parseInt(els.wanderSpeed.value, 10),
    bubbleEnabled: els.bubbleEnabled.checked,
    bubbleLifetimeMs: parseInt(els.bubbleLifetime.value, 10) * 1000,
    bubbleMaxStack: parseInt(els.bubbleStack.value, 10),
    codexBridgeEnabled: els.codexEnabled.checked,
    // Phase 12A — webhook outbound. Bearer token omitted from partial when blank
    // so we don't overwrite an existing token with an empty string on every save.
    webhookOutbound: {
      enabled: els.webhookEnabled.checked,
      urls: webhookUrls,
      ...(els.webhookToken.value.trim() ? { bearerToken: els.webhookToken.value.trim() } : {}),
      eventFilter: {
        stateChanges: els.whFilterState.checked,
        bubbles: els.whFilterBubble.checked,
        errors: els.whFilterError.checked,
      },
    },
  };

  if (currentDisplayId) {
    const newScale = parseFloat(els.scale.value);
    const cfg = await window.ash.getSettings();
    const map = { ...(cfg.displayScales ?? {}) };
    map[currentDisplayId] = newScale;
    partial.displayScales = map;
  }

  await window.ash.saveSettings(partial);
  await window.ash.setOpenAtLogin(els.loginEnabled.checked);

  els.status.textContent = "Saved ✓";
  els.status.style.color = "#34c759";
  setTimeout(() => { els.status.textContent = ""; }, 2000);
}

els.btnApply.addEventListener("click", () => { void applyChanges(); });
els.btnCancel.addEventListener("click", () => { window.close(); });

// ── Activity tab ─────────────────────────────────────────────────────────────

// Agent colors matching renderer.ts AGENT_COLORS (kept in sync manually)
const AGENT_COLOR_MAP: Record<string, string> = {
  "claude-code": "#C97D43",
  "codex":       "#0E8C7B",
  "wander":      "#695C9B",
};

const FALLBACK_COLORS = ["#4F46E5", "#16A34A", "#BE185D", "#B45309", "#0369A1", "#7E22CE"];

function colorForAgent(agent: string | null): string {
  if (!agent || agent === "manual") return "#6B7280";
  if (AGENT_COLOR_MAP[agent]) return AGENT_COLOR_MAP[agent]!;
  let hash = 0;
  for (let i = 0; i < agent.length; i++) {
    hash = (hash * 31 + agent.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length]!;
}

// Event type → display icon + label
function eventMeta(type: string): { icon: string; label: string; filterKey: string } {
  switch (type) {
    case "launch":         return { icon: "▶", label: "Launch",        filterKey: "session" };
    case "shutdown_clean": return { icon: "◼", label: "Shutdown",      filterKey: "session" };
    case "crash_detected": return { icon: "⚡", label: "Crash",         filterKey: "error" };
    case "cleared_log":    return { icon: "⊘", label: "Log cleared",   filterKey: "session" };
    case "state_push":     return { icon: "●", label: "State",         filterKey: "state" };
    case "wander_phase":   return { icon: "🐾", label: "Wander",        filterKey: "wander" };
    case "bubble_spawn":   return { icon: "💬", label: "Bubble",        filterKey: "bubble" };
    case "error":          return { icon: "⚠", label: "Error",         filterKey: "error" };
    case "webhook":        return { icon: "↗", label: "Webhook",       filterKey: "webhook" };
    default:               return { icon: "·", label: type,            filterKey: "session" };
  }
}

// Relative timestamp: "2m ago", "just now", "3h ago", etc.
function relativeTime(isoTs: string): string {
  const diffMs = Date.now() - new Date(isoTs).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Day bucket: returns "Today", "Yesterday", or "Earlier"
function dayBucket(isoTs: string): string {
  const entryDate = new Date(isoTs);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const weekStart = new Date(todayStart.getTime() - 6 * 86400000);
  if (entryDate >= todayStart) return "Today";
  if (entryDate >= yesterdayStart) return "Yesterday";
  if (entryDate >= weekStart) return "Earlier (last 7 days)";
  return "Older";
}

// Short human-readable description from event data
function shortDesc(entry: ActivityLogEntry): string {
  const d = entry.data;
  switch (entry.type) {
    case "state_push": {
      const state = typeof d["state"] === "string" ? d["state"] : "?";
      const agent = typeof d["agent"] === "string" ? d["agent"] : null;
      return agent ? `${state} · ${agent}` : state;
    }
    case "wander_phase": {
      const from = typeof d["from"] === "string" ? d["from"] : "?";
      const to   = typeof d["to"]   === "string" ? d["to"]   : "?";
      return `${from} → ${to}`;
    }
    case "bubble_spawn": {
      const agent = typeof d["agent"] === "string" ? d["agent"] : "?";
      return `agent: ${agent}`;
    }
    case "launch": {
      const ver = typeof d["version"] === "string" ? d["version"] : "";
      return ver ? `v${ver}` : "";
    }
    case "crash_detected": {
      const prev = typeof d["previousSessionId"] === "string" ? d["previousSessionId"].slice(0, 8) : "?";
      return `prev session ${prev}…`;
    }
    default:
      return "";
  }
}

// Active filter set — all on by default
const activeFilters = new Set(["all", "bubble", "wander", "state", "error", "session", "webhook"]);

function filterMatches(entry: ActivityLogEntry): boolean {
  // "all" chip presence means show everything
  if (activeFilters.has("all")) return true;
  const { filterKey } = eventMeta(entry.type);
  return activeFilters.has(filterKey);
}

// Render the full activity feed from loaded entries
let cachedEntries: ActivityLogEntry[] = [];

function renderFeed(entries: ActivityLogEntry[]): void {
  cachedEntries = entries;
  const feed = $<HTMLDivElement>("activity-feed");
  const visible = entries.filter(filterMatches);

  if (visible.length === 0) {
    feed.innerHTML = '<div class="feed-empty">No activity to show.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  let lastBucket = "";

  for (const entry of visible) {
    const bucket = dayBucket(entry.ts);
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      const hdr = document.createElement("div");
      hdr.className = "feed-section-header";
      hdr.textContent = bucket;
      fragment.appendChild(hdr);
    }

    const { icon, label, filterKey } = eventMeta(entry.type);
    const desc = shortDesc(entry);
    const ts = relativeTime(entry.ts);

    // Agent chip — extract from data.agent field if present
    const rawAgent = typeof entry.data["agent"] === "string" ? entry.data["agent"] : null;
    const agentColor = rawAgent ? colorForAgent(rawAgent) : null;

    const row = document.createElement("div");
    row.className = "feed-entry";
    row.dataset["filterKey"] = filterKey;

    row.innerHTML = `
      <div class="entry-icon">${icon}</div>
      <div class="entry-body">
        <div class="entry-main">
          <span class="entry-type">${label}</span>
          ${agentColor ? `<span class="entry-agent-chip" style="background:${agentColor}" title="${rawAgent ?? ""}"></span>` : ""}
          <span class="entry-desc">${desc}</span>
          <span class="entry-ts">${ts}</span>
        </div>
        <pre class="entry-detail">${JSON.stringify({ ts: entry.ts, type: entry.type, data: entry.data }, null, 2)}</pre>
      </div>
    `;

    row.addEventListener("click", () => {
      row.classList.toggle("expanded");
    });

    fragment.appendChild(row);
  }

  feed.innerHTML = "";
  feed.appendChild(fragment);
}

// Render the connected-agents roster (state_push events in last 5 minutes)
function renderAgentRoster(entries: ActivityLogEntry[]): void {
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const agentMap = new Map<string, number>(); // agent → most recent ts (ms)

  for (const entry of entries) {
    if (entry.type !== "state_push") continue;
    const agent = typeof entry.data["agent"] === "string" ? entry.data["agent"] : null;
    if (!agent) continue;
    const tsMs = new Date(entry.ts).getTime();
    if (tsMs < fiveMinAgo) continue;
    const existing = agentMap.get(agent);
    if (existing === undefined || tsMs > existing) agentMap.set(agent, tsMs);
  }

  const list = $<HTMLDivElement>("agent-list");

  if (agentMap.size === 0) {
    list.innerHTML = '<div class="no-agents">No active agents</div>';
    return;
  }

  // Sort by most recently seen
  const sorted = [...agentMap.entries()].sort((a, b) => b[1] - a[1]);
  list.innerHTML = "";

  for (const [agent, tsMs] of sorted) {
    const color = colorForAgent(agent);
    const ago = relativeTime(new Date(tsMs).toISOString());
    const row = document.createElement("div");
    row.className = "agent-row";
    row.innerHTML = `
      <span class="agent-dot" style="background:${color}"></span>
      <span class="agent-name">${agent}</span>
      <span class="agent-last-seen">last seen ${ago}</span>
    `;
    list.appendChild(row);
  }
}

// Load from IPC and render both agent roster + feed
async function loadActivity(): Promise<void> {
  // Gracefully degrade when IPC is not available (e.g. direct HTML open in browser)
  if (!window.ash?.readActivityLog) {
    $<HTMLDivElement>("activity-feed").innerHTML =
      '<div class="feed-empty">IPC unavailable — open via Desktop Ash.</div>';
    return;
  }
  try {
    const entries = await window.ash.readActivityLog() as ActivityLogEntry[];
    renderAgentRoster(entries);
    renderFeed(entries);
  } catch (err) {
    console.error("[settings/activity] loadActivity error:", err);
    $<HTMLDivElement>("activity-feed").innerHTML =
      '<div class="feed-empty">Failed to load activity log.</div>';
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────
// Phase 11C: sidebar-item buttons replace the old horizontal .tab-btn strip.
// The selector targets .sidebar-item; everything else (panel show/hide, polling)
// is unchanged so the activity data flow is unaffected.

let activityRefreshInterval: ReturnType<typeof setInterval> | null = null;

function switchTab(tabId: string): void {
  document.querySelectorAll<HTMLButtonElement>(".sidebar-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset["tab"] === tabId);
  });
  document.querySelectorAll<HTMLDivElement>(".tab-panel").forEach(panel => {
    panel.classList.toggle("active", panel.id === `panel-${tabId}`);
  });

  if (tabId === "activity") {
    void loadActivity();
    // Poll every 5s while tab is active
    activityRefreshInterval = setInterval(() => { void loadActivity(); }, 5000);
  } else {
    if (activityRefreshInterval !== null) {
      clearInterval(activityRefreshInterval);
      activityRefreshInterval = null;
    }
  }
}

document.querySelectorAll<HTMLButtonElement>(".sidebar-item").forEach(btn => {
  btn.addEventListener("click", () => {
    const tabId = btn.dataset["tab"];
    if (tabId) switchTab(tabId);
  });
});

// Stop polling when window is hidden / closed
document.addEventListener("visibilitychange", () => {
  if (document.hidden && activityRefreshInterval !== null) {
    clearInterval(activityRefreshInterval);
    activityRefreshInterval = null;
  }
});

// ── Filter chips ──────────────────────────────────────────────────────────────

document.querySelectorAll<HTMLDivElement>(".chip").forEach(chip => {
  chip.addEventListener("click", () => {
    const filter = chip.dataset["filter"];
    if (!filter) return;

    if (filter === "all") {
      // Toggle "all" — either activate everything or deactivate everything
      const willActivate = !activeFilters.has("all");
      if (willActivate) {
        activeFilters.add("all");
        activeFilters.add("bubble");
        activeFilters.add("wander");
        activeFilters.add("state");
        activeFilters.add("error");
        activeFilters.add("session");
        activeFilters.add("webhook");
      } else {
        activeFilters.clear();
      }
    } else {
      // Toggle individual filter; remove "all" if any individual filter is off
      if (activeFilters.has(filter)) {
        activeFilters.delete(filter);
        activeFilters.delete("all");
      } else {
        activeFilters.add(filter);
        // Re-enable "all" chip if all individual filters are now on
        const individual = ["bubble", "wander", "state", "error", "session", "webhook"];
        if (individual.every(f => activeFilters.has(f))) activeFilters.add("all");
      }
    }

    // Sync chip visual state
    document.querySelectorAll<HTMLDivElement>(".chip").forEach(c => {
      const f = c.dataset["filter"];
      if (f) c.classList.toggle("active", activeFilters.has(f));
    });

    renderFeed(cachedEntries);
  });
});

// ── Clear log button ──────────────────────────────────────────────────────────

$<HTMLButtonElement>("btn-clear-log").addEventListener("click", () => {
  const confirmed = window.confirm("Clear all activity logs? This cannot be undone.");
  if (!confirmed) return;
  if (!window.ash?.clearActivityLog) return;
  window.ash.clearActivityLog()
    .then(() => { void loadActivity(); })
    .catch((err: unknown) => { console.error("[settings/activity] clearActivityLog error:", err); });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

void loadAll();
