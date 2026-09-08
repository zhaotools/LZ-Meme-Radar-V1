import type { RadarToken, SourceHealth } from "../src/shared/types";
import type { Env } from "./env";

interface AlertEvent { type: string; label: string; critical?: boolean }

function securityRank(status: RadarToken["score"]["securityStatus"]) {
  return status === "PASS" ? 2 : status === "UNKNOWN" ? 1 : 0;
}

export function detectAlertEvents(current: RadarToken, previous: RadarToken | null): AlertEvent[] {
  const events: AlertEvent[] = [];
  const priorLevel = previous?.score.level;
  if (current.score.level === "ALPHA_WATCH" && priorLevel !== "ALPHA_WATCH" && priorLevel !== "ALPHA_SIGNAL") {
    events.push({ type: "FIRST_ALPHA_WATCH", label: "首次进入 Alpha Watch" });
  }
  if (current.score.level === "ALPHA_SIGNAL" && priorLevel !== "ALPHA_SIGNAL") {
    events.push({ type: "FIRST_ALPHA_SIGNAL", label: "首次进入 Alpha Signal", critical: true });
  }
  if (current.score.level === "BREAKOUT_WATCH" && priorLevel !== "BREAKOUT_WATCH" && priorLevel !== "BREAKOUT_SIGNAL") {
    events.push({ type: "FIRST_BREAKOUT_WATCH", label: "首次进入 Momentum Breakout Watch" });
  }
  if (current.score.level === "BREAKOUT_SIGNAL" && priorLevel !== "BREAKOUT_SIGNAL") {
    events.push({ type: "FIRST_BREAKOUT_SIGNAL", label: "首次进入 Momentum Breakout Signal", critical: true });
  }
  const launchFlash = current.lane === "launchpad" && ((current.metrics.curveProgressPct ?? 0) >= 0.08 ||
    (current.metrics.volume1hUsd ?? 0) >= 5_000 || (current.metrics.holders ?? 0) >= 20);
  const poolFlash = current.lane === "dex" && (current.metrics.liquidityUsd ?? 0) >= 20_000 &&
    ((current.metrics.volume5mUsd ?? 0) >= 5_000 || (current.metrics.volume1hUsd ?? 0) >= 30_000);
  if (!previous && (launchFlash || poolFlash)) {
    events.push({ type: current.lane === "launchpad" ? "FLASH_TOKEN_CREATED" : "FLASH_POOL_DISCOVERED",
      label: current.lane === "launchpad" ? "Flash：发现新 Token" : "Flash：发现新交易池" });
  } else if (previous && poolFlash && (!previous.pairAddress || (previous.metrics.liquidityUsd ?? 0) < 20_000)) {
    events.push({ type: "FLASH_POOL_DISCOVERED", label: "Flash：新交易池已建立" });
  }
  const thresholds = [5_000_000, 10_000_000, 20_000_000, 50_000_000];
  const currentCap = current.metrics.marketCapUsd ?? 0;
  const previousCap = previous?.metrics.marketCapUsd ?? 0;
  const crossed = thresholds.filter((threshold) => currentCap >= threshold && previousCap < threshold).at(-1);
  if (crossed) {
    const label = crossed >= 1_000_000 ? `${crossed / 1_000_000}M` : String(crossed);
    events.push({ type: `MC_BREAKOUT_${label}`, label: `市值高速突破 $${label}`, critical: crossed >= 20_000_000 });
  }
  const volumeAcceleration = previous?.metrics.volume1hUsd && current.metrics.volume1hUsd
    ? current.metrics.volume1hUsd / previous.metrics.volume1hUsd : 0;
  if (volumeAcceleration >= 1.8 && (current.metrics.volume5mUsd ?? 0) >= 100_000) {
    events.push({ type: "VOLUME_ACCELERATION", label: `成交量加速至前值 ${volumeAcceleration.toFixed(1)} 倍` });
  }
  if (previous?.score.securityStatus === "UNKNOWN" && current.score.securityStatus === "PASS") {
    events.push({ type: "SECURITY_VERIFIED", label: "GoPlus 安全验证通过" });
  }
  if (current.score.alphaInflection && !previous?.score.alphaInflection) {
    events.push({ type: "ALPHA_INFLECTION", label: "出现 Alpha 拐点", critical: true });
  }
  if (previous && current.score.total - previous.score.total >= 10) {
    events.push({ type: "SCORE_JUMP", label: `评分跃升 +${current.score.total - previous.score.total}` });
  }
  const oldLiquidity = previous?.metrics.liquidityUsd;
  const newLiquidity = current.metrics.liquidityUsd;
  if (oldLiquidity && newLiquidity != null && newLiquidity / oldLiquidity <= 0.7) {
    events.push({ type: "LIQUIDITY_DROP", label: "流动性骤降超过 30%", critical: true });
  }
  if ((current.metrics.devNetFlow1hUsd ?? 0) <= -10_000) {
    events.push({ type: "DEV_SELL", label: "Dev 地址出现明显净卖出", critical: true });
  }
  if ((current.metrics.whaleNetFlow1hUsd ?? 0) <= -25_000) {
    events.push({ type: "WHALE_SELL", label: "大户出现明显净卖出" });
  }
  if (previous && securityRank(current.score.securityStatus) < securityRank(previous.score.securityStatus)) {
    events.push({ type: "SAFETY_DOWNGRADE", label: `安全状态降级为 ${current.score.securityStatus}`, critical: true });
  }
  return events;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatUsd(value?: number | null) {
  if (value == null) return "--";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function alertMessage(token: RadarToken, event: AlertEvent) {
  const title = event.critical ? "🚨" : "📡";
  return `${title} <b>${escapeHtml(event.label)}</b>\n` +
    `<b>${escapeHtml(token.name)} (${escapeHtml(token.symbol)})</b>\n` +
    `Alpha ${token.score.total} · ${token.score.level} · ${token.score.track} · 安全 ${token.score.securityStatus}\n` +
    `市值 ${formatUsd(token.metrics.marketCapUsd)} · LP ${formatUsd(token.metrics.liquidityUsd)} · 1H量 ${formatUsd(token.metrics.volume1hUsd)}\n` +
    (token.score.securityStatus === "UNKNOWN" ? `⚠️ 安全数据仍在等待索引，仅作为发现提醒，请勿据此交易。\n` : "") +
    (token.score.riskFlags?.length ? `风险标签 ${token.score.riskFlags.join(", ")}\n` : "") +
    `<code>${token.address}</code>` +
    (token.dexUrl ? `\n<a href="${escapeHtml(token.dexUrl)}">DEX Screener</a>` : "");
}

function inQuietHours(env: Env, now = new Date()) {
  const match = (env.QUIET_HOURS ?? "23:00-08:00").match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) return false;
  const offset = Number(env.ALERT_TIMEZONE_OFFSET ?? 8);
  const minutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + offset * 60 + 1440) % 1440;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

async function alreadySent(env: Env, address: string, type: string) {
  const once = type.startsWith("FIRST_") || type.startsWith("FLASH_") || type.startsWith("MC_BREAKOUT_") ||
    type === "ALPHA_INFLECTION" || type === "SECURITY_VERIFIED";
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const query = once
    ? "SELECT id FROM alerts WHERE address = ? AND alert_type = ? AND delivered = 1 LIMIT 1"
    : "SELECT id FROM alerts WHERE address = ? AND alert_type = ? AND created_at >= ? LIMIT 1";
  const row = once
    ? await env.DB.prepare(query).bind(address, type).first()
    : await env.DB.prepare(query).bind(address, type, cutoff).first();
  return Boolean(row);
}

async function sendTelegram(env: Env, message: string) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Telegram ${response.status}`);
}

async function rateLimited(env: Env) {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM alerts WHERE delivered = 1 AND created_at >= ?")
    .bind(cutoff).first<{ count: number }>();
  return (row?.count ?? 0) >= 5;
}

async function record(env: Env, token: RadarToken, event: AlertEvent, message: string, delivered: boolean, error?: string) {
  const createdAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO alerts(id, address, alert_type, created_at, delivered, mode, message, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), token.address.toLowerCase(), event.type, createdAt, delivered ? 1 : 0,
      env.ALERT_MODE ?? "shadow", message, error ?? null).run();
}

export async function processAlerts(env: Env, token: RadarToken, previous: RadarToken | null) {
  if ((env.ALERT_MODE ?? "shadow") === "off") return 0;
  const detected = detectAlertEvents(token, previous);
  const hasMarketCapBreakout = detected.some((event) => event.type.startsWith("MC_BREAKOUT_"));
  const hasLevelTransition = detected.some((event) => event.type.startsWith("FIRST_"));
  const events = detected.filter((event) =>
    !(hasMarketCapBreakout && (event.type.startsWith("FLASH_") || event.type.startsWith("FIRST_BREAKOUT_"))) &&
    !(hasLevelTransition && !hasMarketCapBreakout && event.type.startsWith("FLASH_")));
  let recorded = 0;
  for (const event of events) {
    if (await alreadySent(env, token.address.toLowerCase(), event.type)) continue;
    const message = alertMessage(token, event);
    if ((env.ALERT_MODE ?? "shadow") !== "live") {
      await record(env, token, event, message, false, "shadow mode");
      recorded += 1;
      continue;
    }
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      await record(env, token, event, message, false, "Telegram secrets missing");
      recorded += 1;
      continue;
    }
    if (inQuietHours(env) && !event.critical) {
      await record(env, token, event, message, false, "quiet hours");
      recorded += 1;
      continue;
    }
    if (await rateLimited(env)) {
      await record(env, token, event, message, false, "rate limited");
      recorded += 1;
      continue;
    }
    try {
      await sendTelegram(env, message);
      await record(env, token, event, message, true);
    } catch (error) {
      await record(env, token, event, message, false, error instanceof Error ? error.message : "unknown error");
    }
    recorded += 1;
  }
  return recorded;
}

export async function processSystemHealthAlerts(env: Env, sources: SourceHealth[]) {
  if ((env.ALERT_MODE ?? "shadow") === "off") return 0;
  const failed = sources.filter((item) => item.status === "error");
  const onChainFailed = failed.some((item) => item.source === "BSC On-chain Events");
  if (!onChainFailed && failed.length < 2) return 0;
  const type = "SOURCE_DEGRADED";
  if (await alreadySent(env, "_system", type)) return 0;
  const message = `🛠 <b>LZ-Meme Radar 数据源降级</b>\n` +
    `${failed.map((item) => `• ${escapeHtml(item.source)}：${escapeHtml(item.lastError ?? "不可用")}`).join("\n")}\n` +
    `当前扫描结果可能遗漏新币，请等待数据源恢复。`;
  const event: AlertEvent = { type, label: "数据源降级", critical: true };
  const createdAt = new Date().toISOString();
  let delivered = false;
  let error: string | undefined;
  if ((env.ALERT_MODE ?? "shadow") !== "live") error = "shadow mode";
  else if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) error = "Telegram secrets missing";
  else {
    try { await sendTelegram(env, message); delivered = true; }
    catch (reason) { error = reason instanceof Error ? reason.message : "unknown error"; }
  }
  await env.DB.prepare(`INSERT INTO alerts(id, address, alert_type, created_at, delivered, mode, message, error)
    VALUES (?, '_system', ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), event.type, createdAt, delivered ? 1 : 0,
      env.ALERT_MODE ?? "shadow", message, error ?? null).run();
  return 1;
}

export async function sendTelegramTest(env: Env, now = new Date()) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { ok: false, error: "Telegram secrets missing" };
  }
  const timestamp = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: "✅ <b>LZ-Meme Radar V1 通知测试成功</b>\n" +
        `时间：${timestamp}（北京时间）\n` +
        "Cloudflare Worker → Telegram → 设备接收链路已连通。\n" +
        "这是一条专用测试消息，不代表真实 Alpha 信号。",
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    description?: string;
    result?: { message_id?: number };
  } | null;
  if (!response.ok || body?.ok !== true) {
    return { ok: false, error: body?.description ?? `Telegram ${response.status}` };
  }
  return { ok: true, messageId: body.result?.message_id ?? null, sentAt: now.toISOString() };
}

export const notificationHelpers = { inQuietHours };
