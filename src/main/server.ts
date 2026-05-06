import http from "node:http";
import type {
  StatePushRequest,
  StatePushResponse,
  StateGetResponse,
  PetState,
} from "../shared/types.js";
import { isValidState } from "../shared/types.js";
import type { StateQueue } from "./state-queue.js";

const PORT = 7878;
const HOST = "127.0.0.1"; // localhost only — never 0.0.0.0

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: object
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createServer(queue: StateQueue): http.Server {
  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    // POST /state — push a new state
    if (method === "POST" && url === "/state") {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw) as Partial<StatePushRequest>;

        const state = body.state;
        if (state === undefined || !isValidState(state)) {
          jsonResponse(res, 400, {
            ok: false,
            error: `Invalid or missing "state". Must be one of: idle, running, running-left, running-right, waving, jumping, failed, waiting, review`,
          });
          return;
        }

        queue.push(state as PetState, {
          ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : undefined,
          agent: typeof body.agent === "string" ? body.agent : null,
          priority: typeof body.priority === "number" ? body.priority : 0,
        });

        const current = queue.getCurrent();
        const response: StatePushResponse = { ok: true, current: current.state };
        jsonResponse(res, 200, response);
      } catch (err) {
        jsonResponse(res, 400, { ok: false, error: "Malformed JSON body" });
      }
      return;
    }

    // GET /state — return current state
    if (method === "GET" && url === "/state") {
      const current = queue.getCurrent();
      const response: StateGetResponse = {
        state: current.state,
        agent: current.agent,
        until: current.expiresAt !== null ? new Date(current.expiresAt).toISOString() : null,
        priority: current.priority,
      };
      jsonResponse(res, 200, response);
      return;
    }

    jsonResponse(res, 404, { error: "Not found" });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[server] listening on http://${HOST}:${PORT}`);
  });

  server.on("error", (err) => {
    console.error("[server] error:", err);
  });

  return server;
}
