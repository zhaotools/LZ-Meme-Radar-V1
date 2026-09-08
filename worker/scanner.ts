import { scoreToken } from "../src/shared/scoring";
import type { RadarToken, SecurityFacts, SourceHealth } from "../src/shared/types";
import { discoverCandidates, enrichCandidates } from "./discovery";
import type { Env } from "./env";
import { processAlerts, processSystemHealthAlerts } from "./notifications";
import { fetchSecurity } from "./security";
import { deferCandidate, getLatestTokens, listDueCandidates, pruneSnapshots,
  recordSourceHealth, saveTokens, seedActiveCandidates, upsertCandidates } from "./storage";

export interface ScanResult {
  runId: string;
  status: "ok" | "partial" | "error";
  discovered: number;
  queued: number;
  tracked: number;
  scored: number;
  alerts: number;
  errors: string[];
  sourceHealth: SourceHealth[];
}

const hasSecurityFacts = (facts: SecurityFacts) => Object.values(facts).some((value) => value !== null && value !== undefined);

export async function scanMarket(env: Env): Promise<ScanResult> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const staleCutoff = new Date(Date.parse(startedAt) - 3 * 60_000).toISOString();
  await env.DB.prepare(`UPDATE scan_runs SET finished_at=?, status='error', error='扫描任务超过 3 分钟，已由后续任务接管'
    WHERE status='running' AND started_at < ?`).bind(startedAt, staleCutoff).run();
  const active = await env.DB.prepare(`SELECT id FROM scan_runs WHERE status='running' AND started_at >= ? LIMIT 1`)
    .bind(staleCutoff).first<{ id: string }>();
  if (active) return { runId: active.id, status: "partial", discovered: 0, queued: 0, tracked: 0,
    scored: 0, alerts: 0, errors: ["已有扫描任务运行中，本轮跳过"], sourceHealth: [] };
  await env.DB.prepare(`INSERT INTO scan_runs(id, started_at, status) VALUES (?, ?, 'running')`)
    .bind(runId, startedAt).run();
  const result: ScanResult = { runId, status: "ok", discovered: 0, queued: 0, tracked: 0,
    scored: 0, alerts: 0, errors: [], sourceHealth: [] };
  try {
    await seedActiveCandidates(env);
    const discovery = await discoverCandidates(env);
    result.discovered = discovery.candidates.length;
    result.sourceHealth.push(...discovery.health);
    for (const health of discovery.health) await recordSourceHealth(env, health);
    await upsertCandidates(env, discovery.candidates, startedAt);

    const tracked = await listDueCandidates(env, 80);
    result.queued = discovery.candidates.length;
    result.tracked = tracked.length;
    const enriched = await enrichCandidates(env, tracked.map((item) => item.candidate));
    result.sourceHealth.push(enriched.health);
    await recordSourceHealth(env, enriched.health);
    const trackingByAddress = new Map(tracked.map((item) => [item.candidate.address.toLowerCase(), item]));
    const pairByToken = new Map(enriched.rows.map((row) => [row.address.toLowerCase(), row.pairAddress ?? null]));
    const securityBatch = await fetchSecurity(env, enriched.rows.map((row) => row.address), pairByToken);
    const highValueMissing = enriched.rows.filter((row) => (row.metrics.marketCapUsd ?? 0) >= 5_000_000 &&
      !hasSecurityFacts(securityBatch.results.get(row.address.toLowerCase())?.facts ?? {})).slice(0, 5);
    const targetedSecurity = await Promise.all(highValueMissing.map((row) =>
      fetchSecurity(env, [row.address], pairByToken)));
    for (const retry of targetedSecurity) {
      for (const [address, value] of retry.results) {
        if (hasSecurityFacts(value.facts)) securityBatch.results.set(address, value);
      }
    }
    const securityCovered = [...securityBatch.results.values()].filter((item) => hasSecurityFacts(item.facts)).length;
    securityBatch.health.candidateCount = securityCovered;
    if (targetedSecurity.some((item) => item.health.status === "ok")) {
      securityBatch.health.lastSuccessAt = new Date().toISOString();
      securityBatch.health.status = securityCovered === enriched.rows.length ? "ok" : "degraded";
    }
    result.sourceHealth.push(securityBatch.health);
    await recordSourceHealth(env, securityBatch.health);
    const previousByAddress = await getLatestTokens(env, enriched.rows.map((row) => row.address));
    const ready: Array<{ token: RadarToken; previous: RadarToken | null }> = [];

    for (const row of enriched.rows) {
      try {
        const address = row.address.toLowerCase();
        const trackedItem = trackingByAddress.get(address);
        if (!trackedItem) continue;
        const previous = previousByAddress.get(address) ?? null;
        const securityResult = securityBatch.results.get(address) ?? { facts: {}, holderCount: null };
        const security = hasSecurityFacts(securityResult.facts) ? securityResult.facts : previous?.security ?? {};
        const firstSeenAt = previous?.firstSeenAt ?? trackedItem.firstSeenAt;
        const tokenCreatedAt = previous?.tokenCreatedAt ?? trackedItem.sourceCreatedAt ?? row.createdAt ?? null;
        const ageOrigin = tokenCreatedAt ?? row.pairCreatedAt ?? firstSeenAt;
        const ageMinutes = Math.max(0, (Date.parse(row.observedAt) - Date.parse(ageOrigin)) / 60_000);
        const previousAge = previous ? Date.parse(row.observedAt) - Date.parse(previous.observedAt) : Infinity;
        const consecutiveScans = previous && previousAge <= 10 * 60_000
          ? (previous.metrics.consecutiveScans ?? 1) + 1 : 1;
        const attention = (row.metrics.crossSourceCount ?? 1) * 20 +
          Math.min(row.metrics.boostAmount ?? 0, 100) + (row.metrics.profileAvailable ? 10 : 0);
        const marketCapChangePct = previous?.metrics.marketCapUsd && row.metrics.marketCapUsd != null
          ? ((row.metrics.marketCapUsd / previous.metrics.marketCapUsd) - 1) * 100 : null;
        const knownMetrics = Object.fromEntries(Object.entries(row.metrics)
          .filter(([, value]) => value !== null && value !== undefined));
        const metrics = {
          ...previous?.metrics,
          ...knownMetrics,
          priorVolume1hUsd: previous?.metrics.volume1hUsd ?? null,
          priorMarketCapUsd: previous?.metrics.marketCapUsd ?? null,
          priorLiquidityUsd: previous?.metrics.liquidityUsd ?? null,
          marketCapChangePct,
          holders: securityResult.holderCount ?? row.metrics.holders ?? previous?.metrics.holders ?? null,
          priorHolders: previous?.metrics.holders ?? null,
          attention,
          priorAttention: previous?.metrics.attention ?? null,
          liquidityChangePct: previous?.metrics.liquidityUsd && row.metrics.liquidityUsd != null
            ? ((row.metrics.liquidityUsd / previous.metrics.liquidityUsd) - 1) * 100 : null,
          consecutiveScans,
        };
        const score = scoreToken({ lane: row.lane, ageMinutes, metrics, security });
        const sourceCreatedAt = tokenCreatedAt ?? row.pairCreatedAt;
        const discoveryLatencySeconds = sourceCreatedAt
          ? Math.max(0, (Date.parse(firstSeenAt) - Date.parse(sourceCreatedAt)) / 1000) : null;
        const token: RadarToken = {
          chainId: "56", address, pairAddress: row.pairAddress,
          name: row.name ?? previous?.name ?? "Unknown", symbol: row.symbol ?? previous?.symbol ?? "?",
          imageUrl: row.imageUrl ?? previous?.imageUrl, source: row.source, lane: row.lane, track: score.track,
          tokenCreatedAt, firstSeenAt, discoveredAt: firstSeenAt, observedAt: row.observedAt,
          pairCreatedAt: row.pairCreatedAt ?? previous?.pairCreatedAt,
          discoveryLatencySeconds, ageMinutes, metrics, security, score,
          dexUrl: row.dexUrl ?? previous?.dexUrl, fourUrl: row.fourUrl ?? previous?.fourUrl,
          fieldSources: { ...previous?.fieldSources, ...row.fieldSources,
            security: "GoPlus Token Security API", holders: "GoPlus Token Security API" },
        };
        ready.push({ token, previous });
      } catch (error) {
        result.errors.push(error instanceof Error ? `${row.address}: ${error.message}` : `${row.address}: unknown error`);
        await deferCandidate(env, row.address, 2);
      }
    }
    await saveTokens(env, ready.map((item) => item.token));
    result.scored = ready.length;
    for (const item of ready) result.alerts += await processAlerts(env, item.token, item.previous);

    const sourceProblems = result.sourceHealth.filter((item) => item.status === "error" || item.status === "degraded");
    if (sourceProblems.length || result.errors.length) result.status = "partial";
    if (!result.scored && !tracked.length && discovery.health.every((item) => item.status === "error")) result.status = "error";
    result.alerts += await processSystemHealthAlerts(env, result.sourceHealth);
    await pruneSnapshots(env);
  } catch (error) {
    result.status = "error";
    result.errors.push(error instanceof Error ? error.message : "unknown scan error");
  }
  const sourceErrors = result.sourceHealth.filter((item) => item.status === "error")
    .map((item) => `${item.source}: ${item.lastError ?? "不可用"}`);
  const errors = [...sourceErrors, ...result.errors];
  await env.DB.prepare(`UPDATE scan_runs SET finished_at = ?, status = ?, discovered_count = ?, queued_count = ?,
    tracked_count = ?, scored_count = ?, alert_count = ?, source_status_json = ?, error = ? WHERE id = ?`)
    .bind(new Date().toISOString(), result.status, result.discovered, result.queued, result.tracked,
      result.scored, result.alerts, JSON.stringify(result.sourceHealth),
      errors.length ? errors.join("\n").slice(0, 4000) : null, runId).run();
  return result;
}
