import type { SecurityFacts, SourceHealth } from "../src/shared/types";
import type { Env } from "./env";

type GoPlusHolder = { address?: string; percent?: string; is_locked?: number | string };
type GoPlusToken = Record<string, unknown> & { holders?: GoPlusHolder[] };

const bool = (value: unknown): boolean | null => {
  if (value === "1" || value === 1 || value === true) return true;
  if (value === "0" || value === 0 || value === false) return false;
  return null;
};
const number = (value: unknown): number | null => {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const burnAddresses = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

function top10(raw: GoPlusToken, pairAddress?: string | null) {
  const pair = pairAddress?.toLowerCase();
  const holders = Array.isArray(raw.holders) ? raw.holders : [];
  const effective = holders.filter((holder) => {
    const address = holder.address?.toLowerCase();
    return address && !burnAddresses.has(address) && address !== pair && bool(holder.is_locked) !== true;
  }).slice(0, 10);
  if (!effective.length) return null;
  return Math.min(1, Math.max(0, effective.reduce((sum, holder) => sum + (number(holder.percent) ?? 0), 0)));
}

export function normalizeGoPlus(raw: GoPlusToken | undefined, pairAddress?: string | null): SecurityFacts {
  if (!raw) return {};
  const dex = Array.isArray(raw.dex) ? raw.dex as Array<Record<string, unknown>> : [];
  const concentratedLiquidity = dex.some((item) => String(item.liquidity_type ?? "").match(/^UniV[34]$/));
  return {
    isHoneypot: bool(raw.is_honeypot),
    cannotBuy: bool(raw.cannot_buy),
    cannotSellAll: bool(raw.cannot_sell_all),
    maliciousContract: bool(raw.is_malicious),
    maliciousCreator: bool(raw.creator_address === "" ? null : raw.is_malicious_creator),
    ownerChangeBalance: bool(raw.owner_change_balance),
    personalSlippageModifiable: bool(raw.personal_slippage_modifiable),
    slippageModifiable: bool(raw.slippage_modifiable),
    transferPausable: bool(raw.transfer_pausable),
    blacklisted: bool(raw.is_blacklisted),
    mintable: bool(raw.is_mintable),
    hiddenOwner: bool(raw.hidden_owner),
    ownerRenounced: bool(raw.owner_address === "" || raw.owner_address === "0x0000000000000000000000000000000000000000"),
    buyTax: number(raw.buy_tax),
    sellTax: number(raw.sell_tax),
    effectiveTop10Pct: top10(raw, pairAddress),
    creatorPct: number(raw.creator_percent),
    lpLockedPct: concentratedLiquidity ? null : number(raw.lp_holders ? Math.min(1,
      Math.max(0, (raw.lp_holders as Array<Record<string, unknown>>)
        .filter((holder) => bool(holder.is_locked) === true)
        .reduce((sum, holder) => sum + (number(holder.percent) ?? 0), 0))) : null),
    openSource: bool(raw.is_open_source),
  };
}

export async function fetchSecurity(env: Env, addresses: string[], pairByToken: Map<string, string | null>) {
  const started = Date.now();
  const lastAttemptAt = new Date(started).toISOString();
  const results = new Map<string, { facts: SecurityFacts; holderCount: number | null }>();
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];
  const errors: string[] = [];
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += 20) batches.push(unique.slice(index, index + 20));
  const responses = await Promise.all(batches.map(async (batch) => {
    const url = new URL("https://api.gopluslabs.io/api/v1/token_security/56");
    url.searchParams.set("contract_addresses", batch.join(","));
    const headers: Record<string, string> = { accept: "application/json" };
    if (env.GOPLUS_TOKEN) headers.Authorization = `Bearer ${env.GOPLUS_TOKEN}`;
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { result?: Record<string, GoPlusToken> };
      return { batch, body };
    } catch (error) {
      return { batch, error: error instanceof Error ? error.message : "unknown error" };
    }
  }));
  for (const response of responses) {
    if ("error" in response) {
      errors.push(response.error ?? "unknown error");
      response.batch.forEach((address) => results.set(address, { facts: {}, holderCount: null }));
    } else {
      response.batch.forEach((address) => {
        const raw = response.body.result?.[address] ?? response.body.result?.[address.toLowerCase()];
        results.set(address, {
          facts: normalizeGoPlus(raw, pairByToken.get(address)),
          holderCount: number(raw?.holder_count),
        });
      });
    }
  }
  const covered = [...results.values()].filter((item) => Object.keys(item.facts).length > 0).length;
  const status: SourceHealth["status"] = errors.length ? (covered ? "degraded" : "error")
    : covered < unique.length ? "degraded" : "ok";
  return {
    results,
    health: {
      source: "GoPlus Security", status, lastAttemptAt,
      lastSuccessAt: covered ? new Date().toISOString() : null,
      lastError: errors.length ? [...new Set(errors)].join("；") : covered < unique.length ? "部分新币尚未被 GoPlus 索引" : null,
      candidateCount: covered, latencyMs: Date.now() - started,
    } satisfies SourceHealth,
  };
}
