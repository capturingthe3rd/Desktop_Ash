import { app } from "electron";
import fs from "fs";
import path from "path";
import os from "os";
import { loadConfig } from "./config.js";

/*
 * Rotation policy (Phase 12B):
 *   Threshold : 50,000 lines (checked via fstat byte-count proxy — see note below).
 *   Trigger   : size-based at ~10 MB (fs.statSync.size), checked once on init.
 *   Atomicity : single fs.renameSync — no copy+truncate, so no torn-write window.
 *   Archives  : activity.jsonl.1 (most recent) → .2 → .3 (oldest kept).
 *               On each rotation, .2→.3, .1→.2, active→.1. .3 is deleted before
 *               the shift to keep retention at exactly 3 generations.
 *   Why size?  Counting lines requires reading the whole file. A 10 MB size guard
 *               is O(1) via statSync and closely tracks the 50k-line goal
 *               (each JSONL entry ≈ 200 bytes → 50k lines ≈ 10 MB).
 */

// Read app version at runtime from package.json in the app root.
// Must be deferred to after app is ready because app.getAppPath() is not
// valid before that — we call this only inside initActivityLog().
function readAppVersion(): string {
  try {
    const pkgPath = path.join(app.getAppPath(), "package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function getLogsDir(): string {
  return path.join(app.getPath("userData"), "logs");
}

function activityLogPath(): string {
  return path.join(getLogsDir(), "activity.jsonl");
}

function heartbeatPath(): string {
  return path.join(getLogsDir(), "heartbeat");
}

function crashLogPath(): string {
  return path.join(getLogsDir(), "crashes.jsonl");
}

// ── Session state (module-level, set once on init) ────────────────────────────

let sessionId: string = "";
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let sessionStartTs: number = 0;

// ── Rolling archive ───────────────────────────────────────────────────────────

// 10 MB threshold — see rotation policy comment at top of file.
const ROTATION_SIZE_BYTES = 10 * 1024 * 1024;

// Shift numbered suffixes (.2→.3, .1→.2) then rename active log to .1.
// Deletes .3 first so we never keep more than 3 rotated generations.
// All renames are atomic on the same filesystem; the active log is gone
// (renamed to .1) before any new writes resume, so no lines are lost.
export function archiveIfNeeded(logsDir?: string): void {
  const dir = logsDir ?? getLogsDir();
  const logPath = path.join(dir, "activity.jsonl");
  if (!fs.existsSync(logPath)) return;

  try {
    const { size } = fs.statSync(logPath);
    if (size < ROTATION_SIZE_BYTES) return;

    // Rotate: delete .3, shift .2→.3, .1→.2, active→.1
    const gen3 = path.join(dir, "activity.jsonl.3");
    const gen2 = path.join(dir, "activity.jsonl.2");
    const gen1 = path.join(dir, "activity.jsonl.1");

    if (fs.existsSync(gen3)) fs.unlinkSync(gen3);
    if (fs.existsSync(gen2)) fs.renameSync(gen2, gen3);
    if (fs.existsSync(gen1)) fs.renameSync(gen1, gen2);
    fs.renameSync(logPath, gen1);

    console.log(`[activity-log] rotated ${size} bytes → activity.jsonl.1`);
  } catch (err) {
    console.warn("[activity-log] archival error:", err);
  }
}

// ── Core writer ───────────────────────────────────────────────────────────────

export function logActivity(type: string, data: object): void {
  try {
    const entry = {
      ts: new Date().toISOString(),
      session_id: sessionId,
      type,
      data,
    };
    fs.appendFileSync(activityLogPath(), JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    // Append fail-safe: never crash the app on a log write failure.
    console.warn("[activity-log] write failed:", err);
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

interface HeartbeatData {
  sessionId: string;
  lastActivityTs: string;
}

function readHeartbeat(): HeartbeatData | null {
  try {
    const raw = fs.readFileSync(heartbeatPath(), "utf-8");
    return JSON.parse(raw) as HeartbeatData;
  } catch {
    return null;
  }
}

function writeHeartbeat(): void {
  try {
    const data: HeartbeatData = {
      sessionId,
      lastActivityTs: new Date().toISOString(),
    };
    fs.writeFileSync(heartbeatPath(), JSON.stringify(data), "utf-8");
  } catch (err) {
    console.warn("[activity-log] heartbeat write failed:", err);
  }
}

function deleteHeartbeat(): void {
  try {
    if (fs.existsSync(heartbeatPath())) {
      fs.unlinkSync(heartbeatPath());
    }
  } catch (err) {
    console.warn("[activity-log] heartbeat delete failed:", err);
  }
}

// ── Crash detection ───────────────────────────────────────────────────────────

// Scan ~/Library/Logs/DiagnosticReports for an Electron-*.ips file whose mtime
// falls within ±60s of the previous session's last known activity timestamp.
function findCrashReport(lastActivityTs: string): string | null {
  const diagDir = path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");
  const targetMs = new Date(lastActivityTs).getTime();
  const windowMs = 60 * 1000;

  try {
    if (!fs.existsSync(diagDir)) return null;
    for (const file of fs.readdirSync(diagDir)) {
      if (!/^Electron-.*\.ips$/.test(file)) continue;
      const filePath = path.join(diagDir, file);
      try {
        if (Math.abs(fs.statSync(filePath).mtimeMs - targetMs) <= windowMs) {
          return filePath;
        }
      } catch {
        // Skip entries we can't stat
      }
    }
  } catch {
    // DiagnosticReports may not be accessible without Full Disk Access — non-fatal.
  }
  return null;
}

function detectAndLogCrash(prev: HeartbeatData): void {
  const ipsPath = findCrashReport(prev.lastActivityTs);
  const durationMs = Math.max(0, sessionStartTs - new Date(prev.lastActivityTs).getTime());

  logActivity("crash_detected", {
    previousSessionId: prev.sessionId,
    lastActivityTs: prev.lastActivityTs,
    ipsPath,
    durationMs,
  });

  try {
    const crashEntry = {
      ts: new Date().toISOString(),
      sessionId: prev.sessionId,
      durationMs,
      ipsPath,
      lastActivityTs: prev.lastActivityTs,
    };
    fs.appendFileSync(crashLogPath(), JSON.stringify(crashEntry) + "\n", "utf-8");
    console.log(`[activity-log] crash detected: prev_session=${prev.sessionId} ips=${ipsPath ?? "none"}`);
  } catch (err) {
    console.warn("[activity-log] crash log write failed:", err);
  }
}

// ── Public surface ────────────────────────────────────────────────────────────

/** Absolute path to the logs directory — for tray "Reveal Logs in Finder". */
export { getLogsDir };

/**
 * Read the last N entries from activity.jsonl.
 * Tolerates malformed lines by skipping them.
 */
export function readActivityLog(limit = 500): import("../shared/types.js").ActivityLogEntry[] {
  const logPath = activityLogPath();
  if (!fs.existsSync(logPath)) return [];
  try {
    const lines = fs.readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit);
    const entries: import("../shared/types.js").ActivityLogEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line) as import("../shared/types.js").ActivityLogEntry);
      } catch {
        // Malformed line — skip, don't crash the dashboard
      }
    }
    return entries.reverse(); // newest-first for the UI
  } catch (err) {
    console.warn("[activity-log] readActivityLog error:", err);
    return [];
  }
}

/**
 * Read the last N entries from crashes.jsonl.
 * Tolerates malformed lines by skipping them.
 */
export function readCrashLog(limit = 100): import("../shared/types.js").CrashLogEntry[] {
  const logPath = crashLogPath();
  if (!fs.existsSync(logPath)) return [];
  try {
    const lines = fs.readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit);
    const entries: import("../shared/types.js").CrashLogEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line) as import("../shared/types.js").CrashLogEntry);
      } catch {
        // skip
      }
    }
    return entries.reverse();
  } catch (err) {
    console.warn("[activity-log] readCrashLog error:", err);
    return [];
  }
}

/**
 * Clear the activity and crash logs. Writes a cleared_log marker so the
 * dashboard shows when the last clear happened.
 */
export function clearActivityLog(): void {
  markCleanShutdown();
  try {
    const logPath = activityLogPath();
    const crashPath = crashLogPath();
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
    if (fs.existsSync(crashPath)) fs.unlinkSync(crashPath);
    if (fs.existsSync(heartbeatPath())) fs.unlinkSync(heartbeatPath());
    // Write a fresh marker so the UI has something to show
    logActivity("cleared_log", { clearedAt: new Date().toISOString() });
    console.log("[activity-log] activity + crash logs cleared");
  } catch (err) {
    console.warn("[activity-log] clearActivityLog error:", err);
  }
}

/**
 * Path to the most recent crash report .ips file that still exists on disk,
 * or null if no crashes have been recorded or all .ips paths have been deleted.
 * Used by the tray "Last Crash Report" menu item.
 */
export function getLatestCrashReportPath(): string | null {
  const logPath = crashLogPath();
  if (!fs.existsSync(logPath)) return null;

  try {
    const lines = fs.readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    // Scan newest-first (last line = most recent crash)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]!) as { ipsPath?: string | null };
        if (entry.ipsPath && fs.existsSync(entry.ipsPath)) {
          return entry.ipsPath;
        }
      } catch {
        // Malformed line — skip
      }
    }
  } catch {
    // Non-fatal
  }
  return null;
}

/**
 * Returns true when crashes.jsonl has at least one entry.
 * Used by the tray to decide whether to show "Last Crash Report".
 */
export function hasCrashLog(): boolean {
  const logPath = crashLogPath();
  if (!fs.existsSync(logPath)) return false;
  try {
    const lines = fs.readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    return lines.length > 0;
  } catch {
    return false;
  }
}

/**
 * Call from before-quit BEFORE closing windows.
 * Writes the shutdown_clean event, cancels the heartbeat interval, and
 * deletes the heartbeat file so the next launch knows this was clean.
 */
export function markCleanShutdown(): void {
  logActivity("shutdown_clean", {});
  if (heartbeatInterval !== null) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  deleteHeartbeat();
  console.log("[activity-log] clean shutdown marked, heartbeat removed");
}

/**
 * Initialize the activity log system. Call once after app.whenReady(),
 * before creating any windows. Handles:
 * - logs directory creation
 * - rolling archive of activity.jsonl if >5000 lines
 * - crash detection via stale heartbeat
 * - fresh heartbeat creation
 * - periodic heartbeat updates every 10s
 * - launch event write
 */
export function initActivityLog(): void {
  sessionId = crypto.randomUUID();
  sessionStartTs = Date.now();

  try {
    fs.mkdirSync(getLogsDir(), { recursive: true });
  } catch (err) {
    console.warn("[activity-log] could not create logs dir:", err);
    return;
  }

  archiveIfNeeded();

  // Crash detection: a stale heartbeat means the previous session did not call
  // markCleanShutdown(), which means it crashed or was force-killed.
  const prev = readHeartbeat();
  if (prev) {
    console.log(`[activity-log] stale heartbeat found (session ${prev.sessionId}) — crash detected`);
    detectAndLogCrash(prev);
    deleteHeartbeat();
  }

  writeHeartbeat();

  heartbeatInterval = setInterval(writeHeartbeat, 10000);
  // unref so this interval doesn't prevent Node from exiting if all else is done
  if (heartbeatInterval.unref) heartbeatInterval.unref();

  const configSnapshot = loadConfig();
  logActivity("launch", {
    version: readAppVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    configSnapshot,
  });

  console.log(`[activity-log] initialized session=${sessionId} logs=${getLogsDir()}`);
}
