import http from "node:http";
import https from "node:https";
import type { AppConfig, WebhookEvent, WebhookOutboundConfig } from "../shared/types.js";
import { logActivity } from "./activity-log.js";

const TIMEOUT_MS = 2000;

// POST a single webhook event to one URL. Fire-and-forget — never throws.
function postToUrl(url: string, body: string, bearerToken: string | undefined): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    logActivity("webhook", { url, error: "invalid URL — skipped" });
    return;
  }

  const isHttps = parsed.protocol === "https:";
  const transport = isHttps ? https : http;

  const options: http.RequestOptions = {
    method: "POST",
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent": "DesktopAsh/1.0 webhook-outbound",
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
  };

  const req = transport.request(options, (res) => {
    // Drain the response body so the socket closes cleanly.
    res.resume();
    logActivity("webhook", { url, status: res.statusCode });
  });

  req.setTimeout(TIMEOUT_MS, () => {
    req.destroy(new Error("timeout"));
  });

  req.on("error", (err) => {
    logActivity("webhook", { url, error: err.message });
  });

  req.write(body);
  req.end();
}

/**
 * Dispatch a webhook event to all configured URLs in parallel.
 * Fire-and-forget — returns immediately; delivery failures are logged, never rethrown.
 *
 * Guards checked before calling:
 *   webhookOutbound.enabled === true
 *   the relevant eventFilter flag === true
 */
export function dispatchWebhook(event: WebhookEvent, config: AppConfig): void {
  const cfg: WebhookOutboundConfig | undefined = config.webhookOutbound;
  if (!cfg?.enabled || !cfg.urls || cfg.urls.length === 0) return;

  const body = JSON.stringify(event);

  for (const url of cfg.urls) {
    const trimmed = url.trim();
    if (!trimmed) continue;
    postToUrl(trimmed, body, cfg.bearerToken);
  }
}
