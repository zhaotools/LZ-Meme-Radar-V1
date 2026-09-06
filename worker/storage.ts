import type { RadarResponse, RadarToken } from "../src/shared/types";
import type { Env } from "./env";

export async function getLatestToken(env: Env, address: string): Promise<RadarToken | null> {
  const row = await env.DB.prepare("SELECT latest_json FROM tokens WHERE address = ?")
    .bind(address.toLowerCase()).first<{ latest_json: string }>();
  return row ? JSON.parse(row.latest_json) as RadarToken : null;
}

export async function saveToken(env: Env, token: RadarToken) {
  const address = token.address.toLowerCase();
  const snapshotId = `${address}:${token.observedAt}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO tokens (
      address, chain_id, symbol, name, lane, source, pair_address, discovered_at, observed_at,
      latest_score, latest_level, security_status, latest_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      symbol=excluded.symbol, name=excluded.name, lane=excluded.lane, source=excluded.source,
      pair_address=excluded.pair_address, observed_at=excluded.observed_at,
      latest_score=excluded.latest_score, latest_level=excluded.latest_level,
      security_status=excluded.security_status, latest_json=excluded.latest_json`)
      .bind(address, token.chainId, token.symbol, token.name, token.lane, token.source,
        token.pairAddress ?? null, token.discoveredAt, token.observedAt, token.score.total,
        token.score.level, token.score.securityStatus, JSON.stringify(token)),
    env.DB.prepare(`INSERT OR REPLACE INTO snapshots
      (id, address, observed_at, score, level, security_status, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(snapshotId, address, token.observedAt, token.score.total, token.score.level,
        token.score.securityStatus, JSON.stringify(token)),
  ]);
}

export async function listRadar(env: Env, limit = 200): Promise<RadarResponse> {
  const safeLimit = Math.max(1, Math.min(500, limit));
  const activeCutoff = new Date(Date.now() - 72 * 60 * 60_000).toISOString();
  const rows = await env.DB.prepare(`SELECT latest_json FROM tokens WHERE discovered_at >= ?
    ORDER BY latest_score DESC, observed_at DESC LIMIT ?`)
    .bind(activeCutoff, safeLimit).all<{ latest_json: string }>();
  const tokens = (rows.results ?? []).map((row) => JSON.parse(row.latest_json) as RadarToken);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const [alerts, discovered] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM alerts WHERE delivered = 1 AND created_at >= ?")
      .bind(since).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM tokens WHERE discovered_at >= ?")
      .bind(since).first<{ count: number }>(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    sourceMode: "live",
    scanStatus: "ok",
    summary: {
      discovered24h: discovered?.count ?? 0,
      riskPass: tokens.filter((token) => token.score.securityStatus === "PASS").length,
      alphaWatch: tokens.filter((token) => token.score.level === "ALPHA_WATCH").length,
      alphaSignal: tokens.filter((token) => token.score.level === "ALPHA_SIGNAL").length,
      alertsSent: alerts?.count ?? 0,
    },
    tokens,
    notices: tokens.length ? [] : ["扫描器尚未写入数据，请先配置 RPC 并触发首次扫描。"],
  };
}

export async function tokenHistory(env: Env, address: string, limit = 120) {
  const result = await env.DB.prepare(`SELECT observed_at, score, level, security_status, snapshot_json
    FROM snapshots WHERE address = ? ORDER BY observed_at DESC LIMIT ?`)
    .bind(address.toLowerCase(), Math.max(1, Math.min(500, limit)))
    .all<{ observed_at: string; score: number; level: string; security_status: string; snapshot_json: string }>();
  return (result.results ?? []).map((row) => ({
    observedAt: row.observed_at,
    score: row.score,
    level: row.level,
    securityStatus: row.security_status,
    metrics: (JSON.parse(row.snapshot_json) as RadarToken).metrics,
  }));
}

export async function getState(env: Env, key: string) {
  const row = await env.DB.prepare("SELECT state_value FROM scanner_state WHERE state_key = ?")
    .bind(key).first<{ state_value: string }>();
  return row?.state_value ?? null;
}

export async function setState(env: Env, key: string, value: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO scanner_state(state_key, state_value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET state_value=excluded.state_value, updated_at=excluded.updated_at`)
    .bind(key, value, now).run();
}

export async function pruneSnapshots(env: Env) {
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  await env.DB.prepare("DELETE FROM snapshots WHERE observed_at < ?").bind(cutoff).run();
}
