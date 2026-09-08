import type { RadarLane, RadarMetrics, SourceHealth } from "../src/shared/types";
import type { DiscoveryContract, Env } from "./env";
import { getState, setState } from "./storage";

const PANCAKE_V2_FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
const PAIR_CREATED_TOPIC = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const PANCAKE_V3_FACTORY = "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865";
const POOL_CREATED_TOPIC = "0x90b8dd367dea5be1bd54ad8a2fffde95bbc9bfd82366d555565b0b9a4bfd2a12";
const FOUR_TOKEN_MANAGER2 = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
const FOUR_TOKEN_CREATE_TOPIC = "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20";
const OPENFOUR_REGISTRY = "0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94";
const OPENFOUR_CORE_SELECTOR = "0x7ba9413c";
const OPENFOUR_TOKEN_CREATED_TOPIC = "0x7dae4dcd1b20eb0445e7cc1d02b3e2e7f32fa63081a0e764732c269f2b8f228f";
const QUOTE_TOKENS = new Set([
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
  "0x55d398326f99059ff775485246999027b3197955", // USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
]);
const PUBLIC_LOG_RPCS = ["https://bsc-rpc.publicnode.com", "https://1rpc.io/bnb", "https://bsc.drpc.org"];

export interface Candidate {
  address: string;
  source: string;
  lane: RadarLane;
  pairAddress?: string | null;
  name?: string;
  symbol?: string;
  imageUrl?: string | null;
  profileAvailable?: boolean;
  boostAmount?: number;
  crossSourceCount?: number;
  dexUrl?: string | null;
  fourUrl?: string | null;
  createdAt?: string | null;
  initialMetrics?: Partial<RadarMetrics>;
  fieldSources?: Record<string, string>;
}

interface DexPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
  boosts?: { active?: number };
}

interface GeckoPoolResponse {
  data?: Array<{
    attributes?: {
      address?: string;
      pool_created_at?: string;
      fdv_usd?: string;
      market_cap_usd?: string | null;
      reserve_in_usd?: string;
      base_token_price_usd?: string;
      price_change_percentage?: Record<string, string>;
      transactions?: Record<string, { buys?: number; sells?: number; buyers?: number; sellers?: number }>;
      volume_usd?: Record<string, string>;
    };
    relationships?: {
      base_token?: { data?: { id?: string } };
      quote_token?: { data?: { id?: string } };
      dex?: { data?: { id?: string } };
    };
  }>;
  included?: Array<{
    id?: string;
    attributes?: { address?: string; name?: string; symbol?: string; image_url?: string | null };
  }>;
}

export interface EnrichedCandidate extends Candidate {
  pairCreatedAt?: string | null;
  ageMinutes: number;
  observedAt: string;
  dexUrl?: string | null;
  metrics: RadarMetrics;
  fieldSources: Record<string, string>;
  createdAt?: string | null;
}

async function rpc<T>(env: Env, method: string, params: unknown[]): Promise<T> {
  const endpoints = [...new Set([env.BSC_RPC_URL, env.BSC_RPC_FALLBACK_URL, ...PUBLIC_LOG_RPCS].filter(Boolean))] as string[];
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { result?: T; error?: { message?: string } };
      if (body.error || body.result === undefined) throw new Error(body.error?.message ?? `${method} 无结果`);
      return body.result;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown error");
    }
  }
  throw new Error(`BSC RPC ${method} 失败：${errors.join("；")}`);
}

const topicAddress = (topic?: string) => topic && topic.length >= 42 ? `0x${topic.slice(-40)}`.toLowerCase() : null;
const dataAddress = (data?: string, word = 0) => data && data.length >= 2 + (word + 1) * 64
  ? `0x${data.slice(2 + word * 64 + 24, 2 + (word + 1) * 64)}`.toLowerCase() : null;

async function configuredContracts(env: Env): Promise<DiscoveryContract[]> {
  let custom: DiscoveryContract[] = [];
  try {
    custom = JSON.parse(env.DISCOVERY_CONTRACTS_JSON || "[]") as DiscoveryContract[];
  } catch {
    custom = [];
  }
  const pancakeV2: DiscoveryContract = {
    name: "PancakeSwap V2", kind: "pancake-v2", address: PANCAKE_V2_FACTORY, topic0: PAIR_CREATED_TOPIC,
  };
  const defaults: DiscoveryContract[] = [
    pancakeV2,
    {
      name: "PancakeSwap V3", kind: "pancake-v3", address: PANCAKE_V3_FACTORY,
      topic0: POOL_CREATED_TOPIC,
    },
    {
      name: "Four.meme TokenManager2", kind: "launchpad", address: FOUR_TOKEN_MANAGER2,
      topic0: FOUR_TOKEN_CREATE_TOPIC, tokenDataWord: 1,
    },
  ];
  try {
    const encodedCore = await rpc<string>(env, "eth_call", [{ to: OPENFOUR_REGISTRY, data: OPENFOUR_CORE_SELECTOR }, "latest"]);
    const core = dataAddress(encodedCore);
    if (core) defaults.push({
      name: "OpenFour TokenCreated", kind: "launchpad", address: core,
      topic0: OPENFOUR_TOKEN_CREATED_TOPIC, tokenTopicIndex: 3,
    });
  } catch {
    // Legacy Four.meme and configured adapters remain available if Registry lookup is temporarily unavailable.
  }
  return [
    ...defaults,
    ...custom,
  ].filter((item, index, all) => all.findIndex((other) => other.address.toLowerCase() === item.address.toLowerCase() && other.topic0 === item.topic0) === index);
}

async function discoverLogs(env: Env): Promise<Candidate[]> {
  const currentHex = await rpc<string>(env, "eth_blockNumber", []);
  const current = Number.parseInt(currentHex, 16);
  const candidates: Candidate[] = [];
  let successfulRanges = 0;

  for (const contract of await configuredContracts(env)) {
    const stateSuffix = `${contract.address.toLowerCase()}:${contract.topic0.slice(0, 12)}`;
    const lastSaved = Number(await getState(env, `last_block:${stateSuffix}`));
    const liveFrom = Number.isFinite(lastSaved) && lastSaved > 0
      ? Math.max(lastSaved + 1, current - 1_500)
      : Math.max(contract.fromBlock ?? 0, current - 1_500);
    const backfillSaved = Number(await getState(env, `backfill_before:${stateSuffix}`));
    const backfillBefore = Number.isFinite(backfillSaved) && backfillSaved > 0 ? backfillSaved : liveFrom;
    // Initial recovery covers roughly the most recent hour; older tracked tokens are seeded from D1.
    // A bounded backfill keeps live events ahead of historical pool noise on high-throughput BSC.
    const oldest = Math.max(contract.fromBlock ?? 0, current - 6_000);
    const ranges: Array<[number, number, "live" | "backfill"]> = [[liveFrom, current, "live"]];
    if (backfillBefore > oldest) ranges.push([Math.max(oldest, backfillBefore - 1_500), backfillBefore - 1, "backfill"]);

    for (const [from, to, mode] of ranges) {
      if (from > to) continue;
      try {
        const logs = await rpc<Array<{ topics: string[]; data: string }>>(env, "eth_getLogs", [{
          address: contract.address,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          topics: [contract.topic0],
        }]);
        successfulRanges += 1;
        for (const log of logs) {
          if (contract.kind === "pancake-v2" || contract.kind === "pancake-v3") {
            const token0 = topicAddress(log.topics[1]);
            const token1 = topicAddress(log.topics[2]);
            const pairAddress = dataAddress(log.data, contract.kind === "pancake-v3" ? 1 : 0);
            if (!token0 || !token1 || !pairAddress) continue;
            const token = QUOTE_TOKENS.has(token0) ? token1 : QUOTE_TOKENS.has(token1) ? token0 : null;
            if (token) candidates.push({ address: token, pairAddress,
              source: mode === "backfill" ? `${contract.name} Backfill` : contract.name, lane: "dex" });
          } else {
            const token = contract.tokenDataWord == null
              ? topicAddress(log.topics[contract.tokenTopicIndex ?? 3])
              : dataAddress(log.data, contract.tokenDataWord);
            const pairAddress = contract.pairTopicIndex == null ? null : topicAddress(log.topics[contract.pairTopicIndex]);
            if (token) candidates.push({
              address: token,
              pairAddress,
              source: mode === "backfill" ? `${contract.name} Backfill` : contract.name,
              lane: "launchpad",
              fourUrl: `https://four.meme/token/${token}`,
            });
          }
        }
        if (mode === "live") await setState(env, `last_block:${stateSuffix}`, String(current));
        else await setState(env, `backfill_before:${stateSuffix}`, String(from));
      } catch {
        // Each contract and backfill cursor advances independently; a failed range is retried next scan.
      }
    }
  }
  if (!successfulRanges) throw new Error("所有链上事件范围读取失败");
  return candidates;
}

async function discoverDexAttention(): Promise<Candidate[]> {
  const endpoints = [
    ["https://api.dexscreener.com/token-profiles/latest/v1", "DEX Profile"],
    ["https://api.dexscreener.com/token-boosts/latest/v1", "DEX Boost"],
    ["https://api.dexscreener.com/token-boosts/top/v1", "DEX Top Boost"],
  ] as const;
  const candidates: Candidate[] = [];
  const responses = await Promise.allSettled(endpoints.map(async ([url, source]) => {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`${source} ${response.status}`);
    return { source, rows: await response.json() as Array<Record<string, unknown>> };
  }));
  responses.forEach((result) => {
    if (result.status !== "fulfilled") return;
    result.value.rows.filter((row) => row.chainId === "bsc" && typeof row.tokenAddress === "string").forEach((row) => {
      candidates.push({
        address: String(row.tokenAddress).toLowerCase(),
        source: result.value.source,
        lane: "dex",
        imageUrl: typeof row.icon === "string" ? row.icon : null,
        profileAvailable: result.value.source === "DEX Profile",
        boostAmount: Number(row.totalAmount ?? row.amount ?? 0),
      });
    });
  });
  if (responses.every((result) => result.status === "rejected")) throw new Error("DEX Attention 全部不可用");
  return candidates;
}

export function dexSearchPairsToCandidates(pairs: DexPair[]): Candidate[] {
  const quoteAddresses = new Set([...QUOTE_TOKENS, "0x0000000000000000000000000000000000000000"]);
  return pairs.flatMap((pair) => {
    if (pair.chainId !== "bsc") return [];
    const baseAddress = pair.baseToken?.address?.toLowerCase();
    const quoteAddress = pair.quoteToken?.address?.toLowerCase();
    const tokenInfo = baseAddress && !quoteAddresses.has(baseAddress)
      ? pair.baseToken : quoteAddress && !quoteAddresses.has(quoteAddress) ? pair.quoteToken : null;
    const address = tokenInfo?.address?.toLowerCase();
    if (!address) return [];
    const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null;
    const dexId = pair.dexId ?? "unknown";
    const isLaunchpad = dexId.includes("four") || dexId.includes("flap");
    return [{
      address,
      pairAddress: pair.pairAddress?.toLowerCase() ?? null,
      source: `DEX Screener Search (${dexId})`,
      lane: isLaunchpad ? "launchpad" as const : "dex" as const,
      name: tokenInfo?.name,
      symbol: tokenInfo?.symbol,
      imageUrl: pair.info?.imageUrl ?? null,
      profileAvailable: Boolean(pair.info?.imageUrl),
      boostAmount: pair.boosts?.active ?? 0,
      createdAt,
      dexUrl: pair.url ?? null,
      fourUrl: dexId.includes("four") ? `https://four.meme/token/${address}` : null,
      initialMetrics: {
        priceUsd: pair.priceUsd == null ? null : Number(pair.priceUsd),
        marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
        liquidityUsd: pair.liquidity?.usd ?? null,
        volume5mUsd: pair.volume?.m5 ?? null,
        volume1hUsd: pair.volume?.h1 ?? null,
        volume6hUsd: pair.volume?.h6 ?? null,
        volume24hUsd: pair.volume?.h24 ?? null,
        buys5m: pair.txns?.m5?.buys ?? null,
        sells5m: pair.txns?.m5?.sells ?? null,
        txBuys1h: pair.txns?.h1?.buys ?? null,
        txSells1h: pair.txns?.h1?.sells ?? null,
        priceChange5mPct: pair.priceChange?.m5 ?? null,
        priceChange1hPct: pair.priceChange?.h1 ?? null,
        priceChange6hPct: pair.priceChange?.h6 ?? null,
      },
      fieldSources: {
        discovery: "DEX Screener public search",
        market: "DEX Screener",
        transactions: "DEX Screener（交易笔数，不等同独立钱包）",
      },
    }];
  });
}

async function discoverDexSearch(): Promise<Candidate[]> {
  const queries = ["BSC", "BNB meme", "four.meme", "Flap", "CZ meme", "AI meme"];
  const responses = await Promise.allSettled(queries.map(async (query) => {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`DEX Search ${query} ${response.status}`);
    const body = await response.json() as { pairs?: DexPair[] };
    return dexSearchPairsToCandidates(body.pairs ?? []);
  }));
  const fulfilled = responses.filter((item): item is PromiseFulfilledResult<Candidate[]> => item.status === "fulfilled");
  if (!fulfilled.length) throw new Error("DEX Screener Search 全部不可用");
  return fulfilled.flatMap((item) => item.value);
}

const geckoAddress = (id?: string | null) => id?.replace(/^bsc_/i, "").toLowerCase() ?? null;

export function geckoNewPoolsToCandidates(body: GeckoPoolResponse): Candidate[] {
  const included = new Map((body.included ?? []).map((item) => [item.id, item.attributes]));
  const finite = (value: unknown) => {
    if (value === "" || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return (body.data ?? []).flatMap((pool) => {
    const baseId = pool.relationships?.base_token?.data?.id;
    const quoteId = pool.relationships?.quote_token?.data?.id;
    const baseAddress = geckoAddress(baseId);
    const quoteAddress = geckoAddress(quoteId);
    const geckoQuotes = new Set([...QUOTE_TOKENS, "0x0000000000000000000000000000000000000000"]);
    const tokenId = baseAddress && !geckoQuotes.has(baseAddress)
      ? baseId : quoteAddress && !geckoQuotes.has(quoteAddress) ? quoteId : null;
    const address = geckoAddress(tokenId);
    const attributes = pool.attributes;
    if (!address || !tokenId || !attributes) return [];
    const token = included.get(tokenId);
    const poolAddress = attributes.address?.toLowerCase() ?? null;
    const dexId = pool.relationships?.dex?.data?.id ?? "unknown";
    const isLaunchpad = dexId.includes("four-meme");
    return [{
      address,
      pairAddress: poolAddress,
      source: `GeckoTerminal New Pools (${dexId})`,
      lane: isLaunchpad ? "launchpad" as const : "dex" as const,
      name: token?.name,
      symbol: token?.symbol,
      imageUrl: token?.image_url ?? null,
      createdAt: attributes.pool_created_at ?? null,
      dexUrl: poolAddress ? `https://www.geckoterminal.com/bsc/pools/${poolAddress}` : null,
      fourUrl: isLaunchpad ? `https://four.meme/token/${address}` : null,
      initialMetrics: {
        priceUsd: finite(attributes.base_token_price_usd),
        marketCapUsd: finite(attributes.market_cap_usd) ?? finite(attributes.fdv_usd),
        liquidityUsd: finite(attributes.reserve_in_usd),
        volume5mUsd: finite(attributes.volume_usd?.m5),
        volume15mUsd: finite(attributes.volume_usd?.m15),
        volume1hUsd: finite(attributes.volume_usd?.h1),
        volume6hUsd: finite(attributes.volume_usd?.h6),
        volume24hUsd: finite(attributes.volume_usd?.h24),
        buys5m: finite(attributes.transactions?.m5?.buys),
        sells5m: finite(attributes.transactions?.m5?.sells),
        txBuys1h: finite(attributes.transactions?.h1?.buys),
        txSells1h: finite(attributes.transactions?.h1?.sells),
        buyers1h: finite(attributes.transactions?.h1?.buyers),
        sellers1h: finite(attributes.transactions?.h1?.sellers),
        priceChange5mPct: finite(attributes.price_change_percentage?.m5),
        priceChange1hPct: finite(attributes.price_change_percentage?.h1),
        priceChange6hPct: finite(attributes.price_change_percentage?.h6),
      },
      fieldSources: {
        discovery: "GeckoTerminal BSC new pools",
        market: "GeckoTerminal",
        transactions: "GeckoTerminal（含独立买家/卖家）",
      },
    }];
  });
}

async function discoverGeckoNewPools(): Promise<Candidate[]> {
  const response = await fetch("https://api.geckoterminal.com/api/v2/networks/bsc/new_pools?page=1&include=base_token%2Cquote_token", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`GeckoTerminal New Pools ${response.status}`);
  return geckoNewPoolsToCandidates(await response.json() as GeckoPoolResponse);
}

async function discoverFourApi(): Promise<Candidate[]> {
  const types = ["HOT", "PROGRESS", "NEW"] as const;
  const responses = await Promise.allSettled(types.map(async (type) => {
    const response = await fetch("https://four.meme/meme-api/v1/public/token/search", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ type, listType: "NOR", pageIndex: 1, pageSize: 20, status: "ALL", sort: "DESC" }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Four.meme ${type} ${response.status}`);
    const body = await response.json() as { code?: number; data?: Array<Record<string, unknown>> };
    return { type, rows: Array.isArray(body.data) ? body.data : [] };
  }));
  const fulfilled = responses.filter((item): item is PromiseFulfilledResult<{ type: typeof types[number]; rows: Array<Record<string, unknown>> }> => item.status === "fulfilled");
  if (!fulfilled.length) throw new Error("Four.meme 列表接口全部不可用");
  const interleaved: Array<{ type: string; row: Record<string, unknown> }> = [];
  for (let index = 0; index < 20; index += 1) {
    fulfilled.forEach((result) => {
      if (result.value.rows[index]) interleaved.push({ type: result.value.type, row: result.value.rows[index] });
    });
  }
  return interleaved.flatMap(({ type, row }) => {
    const candidate = fourApiRowToCandidate(type, row);
    return candidate ? [candidate] : [];
  });
}

export function fourApiRowToCandidate(type: string, row: Record<string, unknown>, now = new Date()): Candidate | null {
  const finite = (value: unknown) => {
    if (value === "" || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  if (typeof row.tokenAddress !== "string") return null;
  const createdMs = finite(row.createDate);
  const progress = finite(row.progress);
  const min5 = finite(row.min5Increase);
  const hour = finite(row.hourIncrease);
  const hour4 = finite(row.hour4Increase);
  const ticker = typeof row.shortName === "string" && row.shortName ? row.shortName : "?";
  return {
    address: row.tokenAddress.toLowerCase(),
    source: `Four.meme ${type}`,
    lane: row.status === "TRADE" ? "dex" : "launchpad",
    name: typeof row.name === "string" ? row.name : ticker,
    symbol: ticker,
    createdAt: createdMs ? new Date(createdMs).toISOString() : null,
    imageUrl: typeof row.img === "string" && row.img.startsWith("http") ? row.img : null,
    profileAvailable: Boolean(row.img || row.tag),
    fourUrl: `https://four.meme/token/${row.tokenAddress}`,
    initialMetrics: {
      marketCapUsd: finite(row.cap),
      volume1hUsd: finite(row.hourVol),
      volume6hUsd: finite(row.hour4Vol),
      volume24hUsd: finite(row.day1Vol),
      holders: finite(row.hold),
      priceChange5mPct: min5 == null ? null : min5 * 100,
      priceChange1hPct: hour == null ? null : hour * 100,
      priceChange6hPct: hour4 == null ? null : hour4 * 100,
      curveProgressPct: progress,
    },
    fieldSources: {
      launchpad: `Four.meme public token search (${type})`,
      launchpadUpdated: now.toISOString(),
    },
  };
}

function mergeCandidates(rows: Candidate[]) {
  const merged = new Map<string, Candidate & { sources: Set<string> }>();
  rows.forEach((row) => {
    const address = row.address.toLowerCase();
    const current = merged.get(address);
    if (!current) {
      merged.set(address, { ...row, address, sources: new Set([row.source]) });
      return;
    }
    current.sources.add(row.source);
    current.pairAddress ||= row.pairAddress;
    current.imageUrl ||= row.imageUrl;
    current.fourUrl ||= row.fourUrl;
    current.createdAt ||= row.createdAt;
    current.name ||= row.name;
    current.symbol ||= row.symbol;
    current.initialMetrics = { ...current.initialMetrics, ...row.initialMetrics };
    current.fieldSources = { ...current.fieldSources, ...row.fieldSources };
    current.profileAvailable ||= row.profileAvailable;
    current.boostAmount = Math.max(current.boostAmount ?? 0, row.boostAmount ?? 0);
    if (row.lane === "dex" || row.pairAddress) current.lane = "dex";
  });
  return [...merged.values()].map(({ sources, ...row }) => ({
    ...row,
    source: [...sources].join(" + "),
    crossSourceCount: sources.size,
  }));
}

async function fetchPairsBatch(addresses: string[]): Promise<DexPair[]> {
  const response = await fetch(`https://api.dexscreener.com/tokens/v1/bsc/${addresses.join(",")}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return [];
  const body = await response.json();
  return Array.isArray(body) ? body as DexPair[] : [];
}

function selectPair(pairs: DexPair[], address: string, preferredPair?: string | null) {
  const bsc = pairs.filter((pair) => pair.chainId === "bsc");
  const preferred = preferredPair && bsc.find((pair) => pair.pairAddress?.toLowerCase() === preferredPair.toLowerCase());
  if (preferred) return preferred;
  return bsc
    .filter((pair) => {
      const base = pair.baseToken?.address?.toLowerCase();
      const quote = pair.quoteToken?.address?.toLowerCase();
      return (base === address && quote && QUOTE_TOKENS.has(quote)) || (quote === address && base && QUOTE_TOKENS.has(base));
    })
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
}

function fromPair(candidate: Candidate, pair: DexPair | null, now: Date): EnrichedCandidate | null {
  const address = candidate.address.toLowerCase();
  const tokenInfo = pair?.baseToken?.address?.toLowerCase() === address ? pair.baseToken : pair?.quoteToken;
  const pairCreated = pair?.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null;
  const created = candidate.createdAt ?? pairCreated;
  const ageMinutes = created ? Math.max(0, (now.getTime() - new Date(created).getTime()) / 60_000) : 0;
  const initial = candidate.initialMetrics ?? {};
  const metrics: RadarMetrics = {
    ...initial,
    priceUsd: pair?.priceUsd == null ? initial.priceUsd ?? null : Number(pair.priceUsd),
    marketCapUsd: pair?.marketCap ?? pair?.fdv ?? initial.marketCapUsd ?? null,
    liquidityUsd: pair?.liquidity?.usd ?? initial.liquidityUsd ?? null,
    volume5mUsd: pair?.volume?.m5 ?? initial.volume5mUsd ?? null,
    volume1hUsd: pair?.volume?.h1 ?? initial.volume1hUsd ?? null,
    volume6hUsd: pair?.volume?.h6 ?? initial.volume6hUsd ?? null,
    volume24hUsd: pair?.volume?.h24 ?? initial.volume24hUsd ?? null,
    buys5m: pair?.txns?.m5?.buys ?? initial.buys5m ?? null,
    sells5m: pair?.txns?.m5?.sells ?? initial.sells5m ?? null,
    txBuys1h: pair?.txns?.h1?.buys ?? initial.txBuys1h ?? null,
    txSells1h: pair?.txns?.h1?.sells ?? initial.txSells1h ?? null,
    priceChange5mPct: pair?.priceChange?.m5 ?? initial.priceChange5mPct ?? null,
    priceChange1hPct: pair?.priceChange?.h1 ?? initial.priceChange1hPct ?? null,
    priceChange6hPct: pair?.priceChange?.h6 ?? initial.priceChange6hPct ?? null,
    crossSourceCount: candidate.crossSourceCount ?? 1,
    boostAmount: Math.max(candidate.boostAmount ?? 0, pair?.boosts?.active ?? 0),
    profileAvailable: candidate.profileAvailable ?? false,
  };
  return {
    ...candidate,
    pairAddress: pair?.pairAddress ?? candidate.pairAddress ?? null,
    pairCreatedAt: pairCreated,
    createdAt: created,
    ageMinutes,
    observedAt: now.toISOString(),
    name: tokenInfo?.name ?? candidate.name ?? "Unknown",
    symbol: tokenInfo?.symbol ?? candidate.symbol ?? "?",
    imageUrl: pair?.info?.imageUrl ?? candidate.imageUrl ?? null,
    dexUrl: pair?.url ?? candidate.dexUrl ?? null,
    metrics,
    lane: pair ? "dex" : candidate.lane,
    fieldSources: {
      ...candidate.fieldSources,
      ...(pair ? { market: "DEX Screener", transactions: "DEX Screener（交易笔数，不等同独立钱包）" } : {}),
      discovery: candidate.source,
    },
  };
}

async function enrichAnalytics(env: Env, rows: EnrichedCandidate[]) {
  if (!env.ANALYTICS_URL || !rows.length) return rows;
  try {
    const response = await fetch(env.ANALYTICS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.ANALYTICS_TOKEN ? { authorization: `Bearer ${env.ANALYTICS_TOKEN}` } : {}),
      },
      body: JSON.stringify({ chainId: "56", addresses: rows.map((row) => row.address) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return rows;
    const body = await response.json() as { result?: Record<string, Partial<RadarMetrics>> };
    return rows.map((row) => {
      const extra = body.result?.[row.address] ?? body.result?.[row.address.toLowerCase()];
      return extra ? {
        ...row,
        metrics: { ...row.metrics, ...extra },
        fieldSources: { ...row.fieldSources, analytics: "已配置的链上分析服务" },
      } : row;
    });
  } catch {
    return rows;
  }
}

interface SourceResult { rows: Candidate[]; health: SourceHealth }

async function readSource(name: string, fn: () => Promise<Candidate[]>): Promise<SourceResult> {
  const started = Date.now();
  const lastAttemptAt = new Date(started).toISOString();
  try {
    const rows = await fn();
    return { rows, health: { source: name, status: "ok", lastAttemptAt,
      lastSuccessAt: new Date().toISOString(), candidateCount: rows.length, latencyMs: Date.now() - started } };
  } catch (error) {
    return { rows: [], health: { source: name, status: "error", lastAttemptAt, lastSuccessAt: null,
      lastError: error instanceof Error ? error.message : "unknown error", candidateCount: 0, latencyMs: Date.now() - started } };
  }
}

export async function discoverCandidates(env: Env) {
  const results = await Promise.all([
    readSource("BSC On-chain Events", () => discoverLogs(env)),
    readSource("DEX Screener Attention", discoverDexAttention),
    readSource("DEX Screener Search", discoverDexSearch),
    readSource("Four.meme API", discoverFourApi),
    readSource("GeckoTerminal New Pools", discoverGeckoNewPools),
  ]);
  return { candidates: mergeCandidates(results.flatMap((result) => result.rows)), health: results.map((result) => result.health) };
}

export async function enrichCandidates(env: Env, candidates: Candidate[]) {
  const now = new Date();
  const enriched: EnrichedCandidate[] = [];
  let marketHealth: SourceHealth;
  const started = Date.now();
  try {
    for (let index = 0; index < candidates.length; index += 30) {
      const group = candidates.slice(index, index + 30);
      const pairs = await fetchPairsBatch(group.map((candidate) => candidate.address));
      group.forEach((candidate) => {
      const selected = selectPair(pairs, candidate.address, candidate.pairAddress);
      const row = fromPair(candidate, selected, now);
      if (row && row.ageMinutes <= 72 * 60) enriched.push(row);
    });
    }
    marketHealth = { source: "DEX Screener Market", status: "ok", lastAttemptAt: new Date(started).toISOString(),
      lastSuccessAt: new Date().toISOString(), candidateCount: enriched.length, latencyMs: Date.now() - started };
  } catch (error) {
    candidates.forEach((candidate) => {
      const row = fromPair(candidate, null, now);
      if (row && row.ageMinutes <= 72 * 60) enriched.push(row);
    });
    marketHealth = { source: "DEX Screener Market", status: "error", lastAttemptAt: new Date(started).toISOString(),
      lastSuccessAt: null, lastError: error instanceof Error ? error.message : "unknown error",
      candidateCount: 0, latencyMs: Date.now() - started };
  }
  return { rows: await enrichAnalytics(env, enriched), health: marketHealth };
}

export async function discoverAndEnrich(env: Env) {
  const discovery = await discoverCandidates(env);
  const enriched = await enrichCandidates(env, discovery.candidates);
  return enriched.rows;
}
