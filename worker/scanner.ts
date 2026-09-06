import { scoreToken } from "../src/shared/scoring";
import type { RadarToken } from "../src/shared/types";
import { discoverAndEnrich } from "./discovery";
import type { Env } from "./env";
import { processAlerts } from "./notifications";
import { fetchSecurity } from "./security";
import { getLatestToken, pruneSnapshots, saveToken } from "./storage";

export interface ScanResult {
  runId: string;
  status: "ok" | "partial" | "error";
  discovered: number;
  scored: number;
  alerts: number;
  errors: string[];
}

export async function scanMarket(env: Env): Promise<ScanResult> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO scan_runs(id, started_at, status) VALUES (?, ?, 'running')`)
    .bind(runId, startedAt).run();
  const result: ScanResult = { runId, status: "ok", discovered: 0, scored: 0, alerts: 0, errors: [] };
  try {
    const discovered = await discoverAndEnrich(env);
    result.discovered = discovered.length;
    const pairByToken = new Map(discovered.map((row) => [row.address.toLowerCase(), row.pairAddress ?? null]));
    const security = await fetchSecurity(env, discovered.map((row) => row.address), pairByToken);

    for (const row of discovered) {
      try {
        const address = row.address.toLowerCase();
        const previous = await getLatestToken(env, address);
        const securityResult = security.get(address) ?? { facts: {}, holderCount: null };
        const discoveredAt = previous?.discoveredAt ?? row.createdAt ?? row.pairCreatedAt ?? row.observedAt;
        const ageMinutes = Math.max(0, (Date.parse(row.observedAt) - Date.parse(discoveredAt)) / 60_000);
        const previousAge = previous ? Date.parse(row.observedAt) - Date.parse(previous.observedAt) : Infinity;
        const consecutiveScans = previous && previousAge <= 10 * 60_000
          ? (previous.metrics.consecutiveScans ?? 1) + 1 : 1;
        const attention = (row.metrics.crossSourceCount ?? 1) * 20 +
          Math.min(row.metrics.boostAmount ?? 0, 100) + (row.metrics.profileAvailable ? 10 : 0);
        const metrics = {
          ...row.metrics,
          priorVolume1hUsd: previous?.metrics.volume1hUsd ?? null,
          holders: securityResult.holderCount ?? row.metrics.holders ?? null,
          priorHolders: previous?.metrics.holders ?? null,
          attention,
          priorAttention: previous?.metrics.attention ?? null,
          liquidityChangePct: previous?.metrics.liquidityUsd && row.metrics.liquidityUsd != null
            ? ((row.metrics.liquidityUsd / previous.metrics.liquidityUsd) - 1) * 100 : null,
          consecutiveScans,
        };
        const score = scoreToken({ lane: row.lane, ageMinutes, metrics, security: securityResult.facts });
        const token: RadarToken = {
          chainId: "56",
          address,
          pairAddress: row.pairAddress,
          name: row.name ?? "Unknown",
          symbol: row.symbol ?? "?",
          imageUrl: row.imageUrl,
          source: row.source,
          lane: row.lane,
          discoveredAt,
          observedAt: row.observedAt,
          pairCreatedAt: row.pairCreatedAt,
          ageMinutes,
          metrics,
          security: securityResult.facts,
          score,
          dexUrl: row.dexUrl,
          fourUrl: row.fourUrl,
          fieldSources: {
            ...row.fieldSources,
            security: "GoPlus Token Security API",
            holders: "GoPlus Token Security API",
          },
        };
        await saveToken(env, token);
        result.alerts += await processAlerts(env, token, previous);
        result.scored += 1;
      } catch (error) {
        result.errors.push(error instanceof Error ? `${row.address}: ${error.message}` : `${row.address}: unknown error`);
      }
    }
    if (result.errors.length) result.status = "partial";
    await pruneSnapshots(env);
  } catch (error) {
    result.status = "error";
    result.errors.push(error instanceof Error ? error.message : "unknown scan error");
  }
  await env.DB.prepare(`UPDATE scan_runs SET finished_at = ?, status = ?, discovered_count = ?,
    scored_count = ?, alert_count = ?, error = ? WHERE id = ?`)
    .bind(new Date().toISOString(), result.status, result.discovered, result.scored, result.alerts,
      result.errors.length ? result.errors.join("\n").slice(0, 4000) : null, runId).run();
  return result;
}
