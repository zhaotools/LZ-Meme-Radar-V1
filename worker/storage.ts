import type { RadarResponse, RadarToken, ScanRunSummary, SourceHealth, SourceHealthStatus } from "../src/shared/types";
import type { Candidate } from "./discovery";
import type { Env } from "./env";

export interface TrackedCandidate {
  candidate: Candidate;
  firstSeenAt: string;
  sourceCreatedAt?: string | null;
  lastScoredAt?: string | null;
}

const isoAfter = (from: string, minutes: number) => new Date(Date.parse(from) + minutes * 60_000).toISOString();

function priorityFor(candidate: Candidate) {
  if ((candidate.initialMetrics?.marketCapUsd ?? 0) >= 5_000_000 ||
    (candidate.initialMetrics?.volume1hUsd ?? 0) >= 500_000) return 120;
  const source = candidate.source.toLowerCase();
  if (source.includes("backfill")) return 70;
  if (source.includes("pancakeswap") || source.includes("tokenmanager") || source.includes("openfour")) return 100;
  if (source.includes("four.meme new")) return 95;
  if (source.includes("geckoterminal")) return 85;
  if (source.includes("profile")) return 65;
  if (source.includes("boost")) return 55;
  return 40;
}

export async function getLatestToken(env: Env, address: string): Promise<RadarToken | null> {
  const row = await env.DB.prepare("SELECT latest_json FROM tokens WHERE address = ?")
    .bind(address.toLowerCase()).first<{ latest_json: string }>();
  return row ? JSON.parse(row.latest_json) as RadarToken : null;
}

export async function getLatestTokens(env: Env, addresses: string[]): Promise<Map<string, RadarToken>> {
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];
  const tokens = new Map<string, RadarToken>();
  for (let index = 0; index < unique.length; index += 60) {
    const batch = unique.slice(index, index + 60);
    if (!batch.length) continue;
    const placeholders = batch.map(() => "?").join(",");
    const rows = await env.DB.prepare(`SELECT address, latest_json FROM tokens WHERE address IN (${placeholders})`)
      .bind(...batch).all<{ address: string; latest_json: string }>();
    for (const row of rows.results ?? []) tokens.set(row.address.toLowerCase(), JSON.parse(row.latest_json) as RadarToken);
  }
  return tokens;
}

function candidateFromToken(token: RadarToken): Candidate {
  return {
    address: token.address, source: token.source, lane: token.lane, pairAddress: token.pairAddress,
    name: token.name, symbol: token.symbol, imageUrl: token.imageUrl,
    createdAt: token.tokenCreatedAt ?? token.pairCreatedAt ?? null, dexUrl: token.dexUrl, fourUrl: token.fourUrl,
    profileAvailable: token.metrics.profileAvailable ?? undefined, boostAmount: token.metrics.boostAmount ?? undefined,
    crossSourceCount: token.metrics.crossSourceCount ?? undefined, fieldSources: token.fieldSources,
  };
}

export async function saveToken(env: Env, token: RadarToken) {
  const address = token.address.toLowerCase();
  const snapshotId = `${address}:${token.observedAt}`;
  const firstSeenAt = token.firstSeenAt ?? token.discoveredAt;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO tokens (
      address, chain_id, symbol, name, lane, source, pair_address, discovered_at, observed_at,
      latest_score, latest_level, security_status, latest_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      symbol=excluded.symbol, name=excluded.name, lane=excluded.lane, source=excluded.source,
      pair_address=excluded.pair_address, discovered_at=excluded.discovered_at, observed_at=excluded.observed_at,
      latest_score=excluded.latest_score, latest_level=excluded.latest_level,
      security_status=excluded.security_status, latest_json=excluded.latest_json`)
      .bind(address, token.chainId, token.symbol, token.name, token.lane, token.source,
        token.pairAddress ?? null, firstSeenAt, token.observedAt, token.score.total,
        token.score.level, token.score.securityStatus, JSON.stringify(token)),
    env.DB.prepare(`INSERT OR REPLACE INTO snapshots
      (id, address, observed_at, score, level, security_status, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(snapshotId, address, token.observedAt, token.score.total, token.score.level,
        token.score.securityStatus, JSON.stringify(token)),
  ]);
}

export async function saveTokens(env: Env, tokens: RadarToken[]) {
  const statements = tokens.flatMap((token) => {
    const address = token.address.toLowerCase();
    const snapshotId = `${address}:${token.observedAt}`;
    const firstSeenAt = token.firstSeenAt ?? token.discoveredAt;
    const candidate = candidateFromToken(token);
    const now = token.observedAt;
    return [
      env.DB.prepare(`INSERT INTO tokens (
        address, chain_id, symbol, name, lane, source, pair_address, discovered_at, observed_at,
        latest_score, latest_level, security_status, latest_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        symbol=excluded.symbol, name=excluded.name, lane=excluded.lane, source=excluded.source,
        pair_address=excluded.pair_address, discovered_at=excluded.discovered_at, observed_at=excluded.observed_at,
        latest_score=excluded.latest_score, latest_level=excluded.latest_level,
        security_status=excluded.security_status, latest_json=excluded.latest_json`)
        .bind(address, token.chainId, token.symbol, token.name, token.lane, token.source,
          token.pairAddress ?? null, firstSeenAt, token.observedAt, token.score.total,
          token.score.level, token.score.securityStatus, JSON.stringify(token)),
      env.DB.prepare(`INSERT OR REPLACE INTO snapshots
        (id, address, observed_at, score, level, security_status, snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(snapshotId, address, token.observedAt, token.score.total, token.score.level,
          token.score.securityStatus, JSON.stringify(token)),
      env.DB.prepare(`UPDATE candidate_queue SET candidate_json=?, last_scored_at=?, next_scan_at=?,
        priority=?, status=CASE WHEN expires_at <= ? THEN 'expired' ELSE 'active' END WHERE address=?`)
        .bind(JSON.stringify(candidate), now, isoAfter(now, nextScanMinutes(token)),
          token.score.breakout ? 110 : priorityFor(candidate), now, address),
    ];
  });
  for (let index = 0; index < statements.length; index += 75) await env.DB.batch(statements.slice(index, index + 75));
}

function candidateUpsert(env: Env, candidate: Candidate, seenAt: string) {
  const address = candidate.address.toLowerCase();
  const createdAt = candidate.createdAt ?? null;
  const expiresBase = createdAt && Number.isFinite(Date.parse(createdAt)) ? createdAt : seenAt;
  const expiresAt = isoAfter(expiresBase, 72 * 60);
  return env.DB.prepare(`INSERT INTO candidate_queue
      (address, candidate_json, priority, status, source_created_at, first_seen_at, last_seen_at, next_scan_at, expires_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        candidate_json=excluded.candidate_json,
        priority=MAX(candidate_queue.priority, excluded.priority), status='active',
        source_created_at=CASE
          WHEN candidate_queue.source_created_at IS NULL THEN excluded.source_created_at
          WHEN excluded.source_created_at IS NULL THEN candidate_queue.source_created_at
          WHEN excluded.source_created_at < candidate_queue.source_created_at THEN excluded.source_created_at
          ELSE candidate_queue.source_created_at END,
        last_seen_at=excluded.last_seen_at,
        next_scan_at=CASE WHEN excluded.next_scan_at < candidate_queue.next_scan_at THEN excluded.next_scan_at ELSE candidate_queue.next_scan_at END,
        expires_at=CASE WHEN excluded.expires_at > candidate_queue.expires_at THEN excluded.expires_at ELSE candidate_queue.expires_at END`)
    .bind(address, JSON.stringify({ ...candidate, address }), priorityFor(candidate), createdAt,
      seenAt, seenAt, seenAt, expiresAt);
}

export async function upsertCandidates(env: Env, candidates: Candidate[], seenAt = new Date().toISOString()) {
  if (!candidates.length) return;
  const statements = candidates.map((candidate) => candidateUpsert(env, candidate, seenAt));
  for (let index = 0; index < statements.length; index += 50) await env.DB.batch(statements.slice(index, index + 50));
}

export async function seedActiveCandidates(env: Env) {
  const cutoff = new Date(Date.now() - 72 * 60 * 60_000).toISOString();
  const rows = await env.DB.prepare(`SELECT t.latest_json,
    COALESCE((SELECT MIN(s.observed_at) FROM snapshots s WHERE s.address=t.address), t.observed_at) AS first_seen
    FROM tokens t LEFT JOIN candidate_queue q ON q.address=t.address
    WHERE q.address IS NULL AND t.observed_at >= ? LIMIT 200`).bind(cutoff)
    .all<{ latest_json: string; first_seen: string }>();
  const statements = (rows.results ?? []).map((row) => {
    const token = JSON.parse(row.latest_json) as RadarToken;
    const candidate = {
      address: token.address, source: token.source, lane: token.lane, pairAddress: token.pairAddress,
      name: token.name, symbol: token.symbol, imageUrl: token.imageUrl,
      createdAt: token.tokenCreatedAt ?? token.pairCreatedAt ?? null, dexUrl: token.dexUrl, fourUrl: token.fourUrl,
      profileAvailable: token.metrics.profileAvailable ?? undefined, boostAmount: token.metrics.boostAmount ?? undefined,
      crossSourceCount: token.metrics.crossSourceCount ?? undefined, fieldSources: token.fieldSources,
    } satisfies Candidate;
    return candidateUpsert(env, candidate, row.first_seen);
  });
  for (let index = 0; index < statements.length; index += 50) await env.DB.batch(statements.slice(index, index + 50));
}

export async function listDueCandidates(env: Env, limit = 80): Promise<TrackedCandidate[]> {
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE candidate_queue SET status='expired' WHERE status='active' AND expires_at <= ?").bind(now).run();
  const rows = await env.DB.prepare(`SELECT candidate_json, first_seen_at, source_created_at, last_scored_at
    FROM candidate_queue WHERE status='active' AND next_scan_at <= ?
    ORDER BY CASE
      WHEN priority >= 110 OR CAST(json_extract(candidate_json, '$.initialMetrics.marketCapUsd') AS REAL) >= 5000000 THEN 0
      ELSE 1 END,
      next_scan_at ASC, priority DESC LIMIT ?`).bind(now, Math.max(1, Math.min(limit, 120)))
    .all<{ candidate_json: string; first_seen_at: string; source_created_at: string | null; last_scored_at: string | null }>();
  return (rows.results ?? []).map((row) => ({ candidate: JSON.parse(row.candidate_json) as Candidate,
    firstSeenAt: row.first_seen_at, sourceCreatedAt: row.source_created_at, lastScoredAt: row.last_scored_at }));
}

function nextScanMinutes(token: RadarToken) {
  if (token.score.securityStatus === "FAIL") return 60;
  if (token.ageMinutes <= 30 || token.score.breakout) return 1;
  if (token.ageMinutes <= 6 * 60) return 2;
  if (token.ageMinutes <= 24 * 60) return 5;
  return 15;
}

export async function markCandidateScored(env: Env, token: RadarToken) {
  const now = token.observedAt;
  const candidate = candidateFromToken(token);
  await env.DB.prepare(`UPDATE candidate_queue SET candidate_json=?, last_scored_at=?, next_scan_at=?,
    priority=?, status=CASE WHEN expires_at <= ? THEN 'expired' ELSE 'active' END WHERE address=?`)
    .bind(JSON.stringify(candidate), now, isoAfter(now, nextScanMinutes(token)),
      token.score.breakout ? 110 : priorityFor(candidate), now, token.address.toLowerCase()).run();
}

export async function deferCandidate(env: Env, address: string, minutes = 2) {
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE candidate_queue SET next_scan_at=? WHERE address=?")
    .bind(isoAfter(now, minutes), address.toLowerCase()).run();
}

export async function recordSourceHealth(env: Env, item: SourceHealth) {
  await env.DB.prepare(`INSERT INTO source_health
    (source, status, last_attempt_at, last_success_at, last_error, candidate_count, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET status=excluded.status, last_attempt_at=excluded.last_attempt_at,
      last_success_at=COALESCE(excluded.last_success_at, source_health.last_success_at),
      last_error=excluded.last_error, candidate_count=excluded.candidate_count, latency_ms=excluded.latency_ms`)
    .bind(item.source, item.status, item.lastAttemptAt, item.lastSuccessAt ?? null,
      item.lastError ?? null, item.candidateCount, item.latencyMs).run();
}

export async function listSourceHealth(env: Env): Promise<SourceHealth[]> {
  const rows = await env.DB.prepare(`SELECT source, status, last_attempt_at, last_success_at,
    last_error, candidate_count, latency_ms FROM source_health ORDER BY source`).all<{
      source: string; status: SourceHealthStatus; last_attempt_at: string; last_success_at: string | null;
      last_error: string | null; candidate_count: number; latency_ms: number;
    }>();
  return (rows.results ?? []).map((row) => ({ source: row.source, status: row.status,
    lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, lastError: row.last_error,
    candidateCount: row.candidate_count, latencyMs: row.latency_ms }));
}

export async function latestScan(env: Env): Promise<ScanRunSummary | null> {
  const row = await env.DB.prepare(`SELECT id, started_at, finished_at, status, discovered_count,
    queued_count, tracked_count, scored_count, alert_count, error FROM scan_runs
    WHERE status != 'running' ORDER BY started_at DESC LIMIT 1`)
    .first<{ id: string; started_at: string; finished_at: string | null; status: ScanRunSummary["status"];
      discovered_count: number; queued_count: number; tracked_count: number; scored_count: number;
      alert_count: number; error: string | null }>();
  return row ? { id: row.id, startedAt: row.started_at, finishedAt: row.finished_at, status: row.status,
    discoveredCount: row.discovered_count, queuedCount: row.queued_count, trackedCount: row.tracked_count,
    scoredCount: row.scored_count, alertCount: row.alert_count, error: row.error } : null;
}

export async function listRadar(env: Env, limit = 200): Promise<RadarResponse> {
  const safeLimit = Math.max(1, Math.min(500, limit));
  const activeCutoff = new Date(Date.now() - 72 * 60 * 60_000).toISOString();
  const rows = await env.DB.prepare(`SELECT latest_json FROM tokens WHERE discovered_at >= ?
    ORDER BY latest_score DESC, observed_at DESC LIMIT ?`).bind(activeCutoff, safeLimit)
    .all<{ latest_json: string }>();
  const tokens = (rows.results ?? []).map((row) => JSON.parse(row.latest_json) as RadarToken);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const [alerts, discovered, sources, scan] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM alerts WHERE delivered = 1 AND created_at >= ?")
      .bind(since).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM tokens WHERE discovered_at >= ?")
      .bind(since).first<{ count: number }>(), listSourceHealth(env), latestScan(env),
  ]);
  const stale = !scan?.finishedAt || Date.now() - Date.parse(scan.finishedAt) > 5 * 60_000;
  const scanStatus = stale ? "error" : scan?.status === "ok" ? "ok" : scan?.status === "partial" ? "partial" : "error";
  const notices = [
    ...(stale ? ["扫描数据超过 5 分钟未更新"] : []),
    ...(scan?.status === "error" ? [scan.error ?? "最近一次扫描失败"] : []),
    ...(scan?.status === "partial" ? ["部分数据源或标的处理失败，当前结果可能不完整"] : []),
    ...(!tokens.length ? ["扫描器尚未写入有效数据"] : []),
  ];
  return {
    generatedAt: new Date().toISOString(), sourceMode: "live", scanStatus,
    summary: {
      discovered24h: discovered?.count ?? 0, riskPass: tokens.filter((t) => t.score.securityStatus === "PASS").length,
      alphaWatch: tokens.filter((t) => t.score.level === "ALPHA_WATCH").length,
      alphaSignal: tokens.filter((t) => t.score.level === "ALPHA_SIGNAL").length,
      breakoutWatch: tokens.filter((t) => t.score.level === "BREAKOUT_WATCH").length,
      breakoutSignal: tokens.filter((t) => t.score.level === "BREAKOUT_SIGNAL").length,
      alertsSent: alerts?.count ?? 0,
    },
    tokens, sourceHealth: sources, latestScan: scan, notices,
  };
}

export async function tokenHistory(env: Env, address: string, limit = 120) {
  const result = await env.DB.prepare(`SELECT observed_at, score, level, security_status, snapshot_json
    FROM snapshots WHERE address = ? ORDER BY observed_at DESC LIMIT ?`)
    .bind(address.toLowerCase(), Math.max(1, Math.min(500, limit)))
    .all<{ observed_at: string; score: number; level: string; security_status: string; snapshot_json: string }>();
  return (result.results ?? []).map((row) => ({ observedAt: row.observed_at, score: row.score,
    level: row.level, securityStatus: row.security_status, metrics: (JSON.parse(row.snapshot_json) as RadarToken).metrics }));
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
  await env.DB.batch([
    env.DB.prepare("DELETE FROM snapshots WHERE observed_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM candidate_queue WHERE status='expired' AND expires_at < ?").bind(cutoff),
  ]);
}
