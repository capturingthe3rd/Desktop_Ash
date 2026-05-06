import fs from "fs";
import path from "path";
import os from "os";
import chokidar from "chokidar";
import { parseCodexLine, mapEventToState } from "./event-mapper.js";
import type { MappedPush } from "./event-mapper.js";

// Callback invoked with a mapped state push. Caller handles the HTTP POST.
type PushCallback = (push: MappedPush) => void;

// Codex sessions live at ~/.codex/sessions/<year>/<YYYY-MM-DD>/rollout-*.jsonl
const CODEX_SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");

// Debounce window in ms — if multiple events fire within this window,
// only the most recent mapped push is forwarded.
const DEBOUNCE_MS = 200;

interface WatcherState {
  // chokidar watcher on the today-directory for new JSONL files appearing
  dirWatcher: ReturnType<typeof chokidar.watch> | null;
  // chokidar watcher on the active JSONL file for new data
  fileWatcher: ReturnType<typeof chokidar.watch> | null;
  // Byte offset — we only read bytes appended since last check
  readOffset: number;
  // Active JSONL file path
  activePath: string | null;
  // Debounce timer handle
  debounceTimer: ReturnType<typeof setTimeout> | null;
  // Pending push (most recent within the debounce window)
  pendingPush: MappedPush | null;
}

// Return today's session directory path, e.g. ~/.codex/sessions/2026/2026-05-06
function todayDir(): string {
  const now = new Date();
  const year = String(now.getFullYear());
  // YYYY-MM-DD
  const dateStr = now.toISOString().slice(0, 10);
  return path.join(CODEX_SESSIONS_ROOT, year, dateStr);
}

// Find the lexicographically latest .jsonl in a directory.
// Latest file name = most recently started session (rollout-<ISO>-<UUID>.jsonl sorts by time).
function latestJsonl(dir: string): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

export class CodexWatcher {
  private state: WatcherState = {
    dirWatcher: null,
    fileWatcher: null,
    readOffset: 0,
    activePath: null,
    debounceTimer: null,
    pendingPush: null,
  };

  private readonly onPush: PushCallback;

  constructor(onPush: PushCallback) {
    this.onPush = onPush;
  }

  start(): void {
    const dir = todayDir();
    console.log(`[codex-bridge] watching session dir: ${dir}`);

    // Latch onto the latest existing file, if any
    const existing = latestJsonl(dir);
    if (existing) {
      this.attachToFile(existing, /* seekToEnd= */ true);
    }

    // Watch the directory for new JSONL files (Codex starts a new session)
    this.state.dirWatcher = chokidar.watch(dir, {
      // Watch for new files only — we don't need content events here
      ignoreInitial: true,
      depth: 0,
    });

    this.state.dirWatcher.on("add", (filePath: string) => {
      if (!filePath.endsWith(".jsonl")) return;
      console.log(`[codex-bridge] new session file: ${filePath}`);
      // New session started — switch to the new file
      this.attachToFile(filePath, /* seekToEnd= */ false);
    });

    this.state.dirWatcher.on("error", (err: unknown) => {
      // Directory may not exist yet if Codex hasn't run today
      console.warn(`[codex-bridge] dir watcher error: ${String(err)}`);
    });
  }

  stop(): void {
    if (this.state.debounceTimer !== null) {
      clearTimeout(this.state.debounceTimer);
      this.state.debounceTimer = null;
    }
    if (this.state.fileWatcher) {
      void this.state.fileWatcher.close();
      this.state.fileWatcher = null;
    }
    if (this.state.dirWatcher) {
      void this.state.dirWatcher.close();
      this.state.dirWatcher = null;
    }
    this.state.activePath = null;
    console.log("[codex-bridge] stopped");
  }

  // Switch the file watcher to a new JSONL path.
  // seekToEnd=true: skip existing content (we only care about new events from now).
  // seekToEnd=false: read from the beginning (new file, we want session_meta).
  private attachToFile(filePath: string, seekToEnd: boolean): void {
    // Tear down old file watcher
    if (this.state.fileWatcher) {
      void this.state.fileWatcher.close();
      this.state.fileWatcher = null;
    }

    this.state.activePath = filePath;

    if (seekToEnd) {
      // Seek to current EOF so we only tail new content
      try {
        const stat = fs.statSync(filePath);
        this.state.readOffset = stat.size;
      } catch {
        this.state.readOffset = 0;
      }
    } else {
      this.state.readOffset = 0;
    }

    // Watch for change events on this specific file
    this.state.fileWatcher = chokidar.watch(filePath, {
      ignoreInitial: true,
      usePolling: false,
    });

    this.state.fileWatcher.on("change", () => {
      this.readNewLines();
    });

    this.state.fileWatcher.on("error", (err: unknown) => {
      console.warn(
        `[codex-bridge] file watcher error on ${filePath}: ${String(err)}`
      );
    });

    console.log(
      `[codex-bridge] tailing: ${filePath} (offset=${this.state.readOffset})`
    );
  }

  // Read all bytes appended since last read, split into lines, parse and map.
  private readNewLines(): void {
    const filePath = this.state.activePath;
    if (!filePath) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    if (stat.size <= this.state.readOffset) return;

    let fd: number;
    try {
      fd = fs.openSync(filePath, "r");
    } catch {
      return;
    }

    const bytesToRead = stat.size - this.state.readOffset;
    const buf = Buffer.allocUnsafe(bytesToRead);
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buf, 0, bytesToRead, this.state.readOffset);
    } catch (err) {
      console.warn(`[codex-bridge] read error: ${String(err)}`);
    } finally {
      fs.closeSync(fd);
    }

    if (bytesRead === 0) return;

    this.state.readOffset += bytesRead;

    const chunk = buf.subarray(0, bytesRead).toString("utf-8");
    const lines = chunk.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      const event = parseCodexLine(line);
      if (!event) {
        // Tolerate parse failures — schema drift or truncated lines
        console.warn(`[codex-bridge] failed to parse line: ${line.slice(0, 80)}`);
        continue;
      }

      const push = mapEventToState(event);
      if (!push) continue;

      // Debounce: hold the most recent push, fire after DEBOUNCE_MS quiet window
      this.state.pendingPush = push;

      if (this.state.debounceTimer !== null) {
        clearTimeout(this.state.debounceTimer);
      }
      this.state.debounceTimer = setTimeout(() => {
        this.state.debounceTimer = null;
        if (this.state.pendingPush) {
          this.onPush(this.state.pendingPush);
          this.state.pendingPush = null;
        }
      }, DEBOUNCE_MS);
    }
  }
}
