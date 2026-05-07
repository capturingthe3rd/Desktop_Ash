#!/usr/bin/env node
/**
 * stress-activity-log.js
 *
 * Standalone stress test for the activity log rotation logic.
 * Runs without Electron — uses a temp directory instead of userData.
 *
 * Mirrors the rotation policy in src/main/activity-log.ts exactly:
 *   - Threshold: 10 MB (ROTATION_SIZE_BYTES)
 *   - Atomicity: single fs.renameSync (no copy+truncate)
 *   - Retention: active + .1 + .2 + .3 (3 rotated generations max)
 *
 * Usage:  npm run stress:activity-log
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// ── Config ────────────────────────────────────────────────────────────────────

const ROTATION_SIZE_BYTES = 10 * 1024 * 1024; // must match activity-log.ts
const TOTAL_ENTRIES = 50_000;
const READ_LIMIT = 500;

// ── Temp working dir ──────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-ash-stress-"));
const logPath = path.join(tmpDir, "activity.jsonl");

function archivePath(n) {
  return path.join(tmpDir, `activity.jsonl.${n}`);
}

console.log(`[stress] working dir: ${tmpDir}`);

// ── Rotation logic (mirrored from activity-log.ts) ────────────────────────────

function archiveIfNeeded() {
  if (!fs.existsSync(logPath)) return false;
  const { size } = fs.statSync(logPath);
  if (size < ROTATION_SIZE_BYTES) return false;

  const gen3 = archivePath(3);
  const gen2 = archivePath(2);
  const gen1 = archivePath(1);

  if (fs.existsSync(gen3)) fs.unlinkSync(gen3);
  if (fs.existsSync(gen2)) fs.renameSync(gen2, gen3);
  if (fs.existsSync(gen1)) fs.renameSync(gen1, gen2);
  fs.renameSync(logPath, gen1);

  return true;
}

// ── Write helper (mirrors logActivity) ───────────────────────────────────────

const sessionId = crypto.randomUUID();

function writeEntry(type, data) {
  const entry = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    type,
    data,
  };
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

// ── readActivityLog (mirrors readActivityLog in activity-log.ts) ───────────────

function readActivityLog(limit = READ_LIMIT) {
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const tail = lines.slice(-limit);
  const entries = [];
  for (const line of tail) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return entries.reverse();
}

// ── Assertions ────────────────────────────────────────────────────────────────

let failCount = 0;

function assert(condition, label) {
  if (!condition) {
    console.error(`  FAIL: ${label}`);
    failCount++;
  } else {
    console.log(`  PASS: ${label}`);
  }
}

// ── Main stress run ───────────────────────────────────────────────────────────

console.log(`\n[stress] writing ${TOTAL_ENTRIES.toLocaleString()} entries...`);

let rotationCount = 0;
let rotationLatencies = [];
const writeStart = Date.now();

for (let i = 0; i < TOTAL_ENTRIES; i++) {
  writeEntry("stress_event", {
    index: i,
    payload: `synthetic-entry-${i}-padding-to-inflate-size-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
  });

  // Check rotation after every write (same cadence as real init check,
  // but we call it inline here to stress the boundary precisely).
  // In real app, archiveIfNeeded only runs at launch — here we call it
  // on every write to find the exact line where rotation fires.
  const rotStart = Date.now();
  const rotated = archiveIfNeeded();
  if (rotated) {
    const latencyMs = Date.now() - rotStart;
    rotationLatencies.push(latencyMs);
    rotationCount++;
    console.log(`  [rotation #${rotationCount}] at entry ${i}, latency ${latencyMs}ms`);
  }
}

const writeDurationMs = Date.now() - writeStart;
const writesPerSec = Math.round((TOTAL_ENTRIES / writeDurationMs) * 1000);

console.log(`\n[stress] write phase done in ${writeDurationMs}ms (${writesPerSec.toLocaleString()} writes/sec)`);
console.log(`[stress] total rotations triggered: ${rotationCount}`);
if (rotationLatencies.length > 0) {
  const avgLatency = Math.round(rotationLatencies.reduce((a, b) => a + b, 0) / rotationLatencies.length);
  const maxLatency = Math.max(...rotationLatencies);
  console.log(`[stress] rotation latency: avg=${avgLatency}ms max=${maxLatency}ms`);
}

// ── Assertions ────────────────────────────────────────────────────────────────

console.log("\n[stress] running assertions...");

// 1. At least one rotation fired
assert(rotationCount >= 1, `at least one rotation triggered (got ${rotationCount})`);

// 2. Active log exists and is well-formed JSONL
assert(fs.existsSync(logPath), "active log exists after stress run");

if (fs.existsSync(logPath)) {
  const activeLines = fs.readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  assert(activeLines.length > 0, `active log has entries (got ${activeLines.length})`);

  // Every line must parse as valid JSON
  let allValid = true;
  for (const line of activeLines) {
    try { JSON.parse(line); } catch { allValid = false; break; }
  }
  assert(allValid, "active log is well-formed JSONL");

  // Active log must be below threshold (rotation should have fired)
  const activeSize = fs.statSync(logPath).size;
  assert(activeSize < ROTATION_SIZE_BYTES, `active log size (${activeSize} bytes) is below rotation threshold`);
}

// 3. At least .1 archive exists and is well-formed
assert(fs.existsSync(archivePath(1)), "activity.jsonl.1 exists");

if (fs.existsSync(archivePath(1))) {
  const gen1Lines = fs.readFileSync(archivePath(1), "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  assert(gen1Lines.length > 0, `activity.jsonl.1 has entries (got ${gen1Lines.length})`);

  let allValid = true;
  for (const line of gen1Lines) {
    try { JSON.parse(line); } catch { allValid = false; break; }
  }
  assert(allValid, "activity.jsonl.1 is well-formed JSONL");
}

// 4. No more than 3 rotated archives exist
const archiveCount = [1, 2, 3].filter((n) => fs.existsSync(archivePath(n))).length;
const gen4Exists = fs.existsSync(archivePath(4));
assert(!gen4Exists, "activity.jsonl.4 does NOT exist (retention cap respected)");
console.log(`  INFO: ${archiveCount} rotated archive(s) present (.1 through .${archiveCount})`);

// 5. readActivityLog returns sensible data (newest-first, limit respected)
const entries = readActivityLog(READ_LIMIT);
assert(entries.length > 0, `readActivityLog(${READ_LIMIT}) returns entries`);
assert(entries.length <= READ_LIMIT, `readActivityLog respects limit (got ${entries.length})`);

if (entries.length >= 2) {
  // Newest-first: first entry timestamp >= second entry timestamp
  const t0 = new Date(entries[0].ts).getTime();
  const t1 = new Date(entries[1].ts).getTime();
  assert(t0 >= t1, "readActivityLog returns entries newest-first");
}

// 6. All returned entries are valid ActivityLogEntry shapes
const shapeOk = entries.every((e) =>
  typeof e.ts === "string" &&
  typeof e.session_id === "string" &&
  typeof e.type === "string" &&
  typeof e.data === "object"
);
assert(shapeOk, "all readActivityLog entries have valid ActivityLogEntry shape");

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("\n[stress] final file listing:");
for (const name of ["activity.jsonl", "activity.jsonl.1", "activity.jsonl.2", "activity.jsonl.3"]) {
  const p = path.join(tmpDir, name);
  if (fs.existsSync(p)) {
    const { size } = fs.statSync(p);
    console.log(`  ${name}: ${(size / 1024 / 1024).toFixed(2)} MB`);
  } else {
    console.log(`  ${name}: (not present)`);
  }
}

console.log(`\n[stress] results: ${failCount === 0 ? "ALL PASS" : `${failCount} FAILURE(S)`}`);
console.log(`[stress] logs left at: ${tmpDir}`);

if (failCount > 0) process.exit(1);
