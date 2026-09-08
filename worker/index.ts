import type { Env } from "./env";
import { scanMarket } from "./scanner";
import { sendTelegramTest } from "./notifications";
import { getLatestToken, latestScan, listRadar, listSourceHealth, tokenHistory } from "./storage";

function cors(env: Env, request: Request) {
  const origin = request.headers.get("origin") ?? "";
  const configured = env.ALLOWED_ORIGIN ?? "";
  const allowed = configured.split(",").map((item) => item.trim()).filter(Boolean);
  const value = allowed.includes("*") || allowed.includes(origin) ? origin || "*" : allowed[0] ?? "null";
  return {
    "access-control-allow-origin": value,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(env: Env, request: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(env, request) },
  });
}

function authorized(request: Request, env: Env) {
  if (!env.ADMIN_TOKEN) return false;
  return request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

async function status(env: Env) {
  const [latest, sources] = await Promise.all([latestScan(env), listSourceHealth(env)]);
  const stale = !latest?.finishedAt || Date.now() - Date.parse(latest.finishedAt) > 5 * 60_000;
  return {
    ok: !stale && latest?.status !== "error",
    service: "LZ-Meme Radar V1 API",
    now: new Date().toISOString(),
    configuration: {
      rpc: true,
      rpcMode: env.BSC_RPC_URL ? "configured-with-public-fallbacks" : "public-fallbacks",
      analytics: Boolean(env.ANALYTICS_URL),
      telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
      alertMode: env.ALERT_MODE ?? "shadow",
    },
    latestScan: latest,
    sourceHealth: sources,
  };
}

async function recentAlerts(env: Env) {
  const result = await env.DB.prepare(`SELECT address, alert_type, created_at, delivered, mode, error
    FROM alerts ORDER BY created_at DESC LIMIT 100`).all();
  return result.results ?? [];
}

async function handle(request: Request, env: Env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env, request) });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (request.method === "GET" && (path === "/" || path === "/api/v1/status")) {
    return json(env, request, await status(env));
  }
  if (request.method === "GET" && path === "/api/v1/radar") {
    return json(env, request, await listRadar(env, Number(url.searchParams.get("limit") ?? 200)));
  }
  if (request.method === "GET" && path === "/api/v1/alerts/recent") {
    return json(env, request, { alerts: await recentAlerts(env) });
  }
  if (request.method === "POST" && path === "/api/v1/scan") {
    if (!authorized(request, env)) return json(env, request, { error: "unauthorized" }, 401);
    const result = await scanMarket(env);
    return json(env, request, result, result.status === "error" ? 502 : 200);
  }
  if (request.method === "POST" && path === "/api/v1/telegram/test") {
    if (!authorized(request, env)) return json(env, request, { error: "unauthorized" }, 401);
    const result = await sendTelegramTest(env);
    return json(env, request, result, result.ok ? 200 : 502);
  }
  const historyMatch = path.match(/^\/api\/v1\/tokens\/(0x[a-fA-F0-9]{40})\/history$/);
  if (request.method === "GET" && historyMatch) {
    return json(env, request, { address: historyMatch[1].toLowerCase(), history: await tokenHistory(env, historyMatch[1]) });
  }
  const tokenMatch = path.match(/^\/api\/v1\/tokens\/(0x[a-fA-F0-9]{40})$/);
  if (request.method === "GET" && tokenMatch) {
    const token = await getLatestToken(env, tokenMatch[1]);
    return token ? json(env, request, token) : json(env, request, { error: "token not found" }, 404);
  }
  return json(env, request, { error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      return json(env, request, {
        error: "internal error",
        detail: error instanceof Error ? error.message : "unknown error",
      }, 500);
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scanMarket(env));
  },
};

export { handle };
