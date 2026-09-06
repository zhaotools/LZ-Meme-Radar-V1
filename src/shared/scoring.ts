import type { RadarMetrics, ScoreInput, ScoreResult, SecurityFacts, SecurityStatus, SignalLevel } from "./types";

type Metric = { value: number | boolean | null | undefined; weight: number; score: (value: number | boolean) => number; name: string };

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const linear = (value: number, low: number, high: number) => clamp((value - low) / (high - low));
const inverse = (value: number, good: number, bad: number) => 1 - linear(value, good, bad);
const ratio = (current?: number | null, previous?: number | null) =>
  current == null || previous == null || previous <= 0 ? null : current / previous;

function weighted(metrics: Metric[], maxPoints: number, missing: string[]) {
  const present = metrics.filter((item) => item.value !== null && item.value !== undefined);
  metrics.filter((item) => item.value === null || item.value === undefined).forEach((item) => missing.push(item.name));
  if (!present.length) return { points: 0, available: 0, total: metrics.reduce((sum, item) => sum + item.weight, 0) };
  const availableWeight = present.reduce((sum, item) => sum + item.weight, 0);
  const earned = present.reduce((sum, item) => sum + item.weight * clamp(item.score(item.value as number | boolean)), 0);
  return {
    points: Math.round((earned / availableWeight) * maxPoints),
    available: availableWeight,
    total: metrics.reduce((sum, item) => sum + item.weight, 0),
  };
}

export function evaluateSecurity(facts: SecurityFacts): { status: SecurityStatus; reasons: string[]; coverage: number } {
  const reasons: string[] = [];
  const hardChecks: Array<[keyof SecurityFacts, string]> = [
    ["isHoneypot", "疑似 Honeypot"],
    ["cannotBuy", "无法买入"],
    ["cannotSellAll", "无法全部卖出"],
    ["maliciousContract", "恶意合约"],
    ["maliciousCreator", "恶意创建者"],
    ["ownerChangeBalance", "Owner 可改余额"],
    ["personalSlippageModifiable", "可针对钱包修改滑点"],
  ];
  hardChecks.forEach(([key, label]) => {
    if (facts[key] === true) reasons.push(label);
  });
  if ((facts.buyTax ?? 0) > 0.25 || (facts.sellTax ?? 0) > 0.25) reasons.push("交易税超过 25%");
  if (facts.slippageModifiable === true && facts.ownerRenounced !== true) reasons.push("Owner 可修改交易税");
  if (facts.transferPausable === true && facts.ownerRenounced !== true) reasons.push("Owner 可暂停转账");
  if (facts.blacklisted === true && facts.ownerRenounced !== true) reasons.push("Owner 可设置黑名单");
  if (facts.mintable === true && facts.ownerRenounced !== true) reasons.push("Mint 权限未解除");
  if ((facts.effectiveTop10Pct ?? 0) >= 0.8) reasons.push("有效 Top10 持仓过度集中");
  if (facts.lpLockedPct != null && facts.lpLockedPct < 0.2) reasons.push("LP 锁定比例过低");

  const knowledgeKeys: Array<keyof SecurityFacts> = [
    "isHoneypot", "cannotBuy", "cannotSellAll", "maliciousContract", "maliciousCreator",
    "ownerChangeBalance", "slippageModifiable", "transferPausable", "blacklisted", "mintable",
    "effectiveTop10Pct", "creatorPct", "lpLockedPct", "openSource",
  ];
  const known = knowledgeKeys.filter((key) => facts[key] !== null && facts[key] !== undefined).length;
  const coverage = Math.round((known / knowledgeKeys.length) * 100);
  if (reasons.length) return { status: "FAIL", reasons, coverage };
  if (coverage < 70) return { status: "UNKNOWN", reasons: ["安全字段覆盖不足"], coverage };
  return { status: "PASS", reasons: [], coverage };
}

function isEligible(input: ScoreInput) {
  const { lane, ageMinutes, metrics } = input;
  if (ageMinutes < 10 || ageMinutes > 72 * 60) return false;
  if (lane === "launchpad") {
    return (metrics.curveProgressPct ?? 0) >= 0.08 || (metrics.raisedBnb ?? 0) >= 1;
  }
  return (
    (metrics.marketCapUsd ?? 0) >= 50_000 &&
    (metrics.marketCapUsd ?? Infinity) <= 5_000_000 &&
    (metrics.liquidityUsd ?? 0) >= 20_000 &&
    (metrics.volume1hUsd ?? 0) >= 30_000 &&
    (metrics.txBuys1h ?? 0) > (metrics.txSells1h ?? Infinity)
  );
}

export function scoreToken(input: ScoreInput): ScoreResult {
  const { metrics: m, security: s } = input;
  const missing: string[] = [];
  const security = evaluateSecurity(s);
  const buySellRatio = m.txBuys1h != null && m.txSells1h != null && m.txSells1h > 0 ? m.txBuys1h / m.txSells1h : null;
  const holderGrowth = ratio(m.holders, m.priorHolders);
  const buyerAcceleration = ratio(m.buyers1h, m.priorBuyers1h);
  const volumeAcceleration = ratio(m.volume1hUsd, m.priorVolume1hUsd);
  const freshAcceleration = ratio(m.freshWallets1h, m.priorFreshWallets1h);
  const attentionAcceleration = ratio(m.attention, m.priorAttention);
  const lpMc = m.liquidityUsd != null && m.marketCapUsd != null && m.marketCapUsd > 0 ? m.liquidityUsd / m.marketCapUsd : null;

  const funds = weighted([
    { value: m.netBuy1hUsd, weight: 10, score: (v) => linear(Number(v), 0, 100_000), name: "1h 净买入" },
    { value: buyerAcceleration, weight: 8, score: (v) => linear(Number(v), 1, 2.2), name: "独立买家加速" },
    { value: volumeAcceleration, weight: 7, score: (v) => linear(Number(v), 1, 2.5), name: "成交量加速" },
    { value: buySellRatio, weight: 5, score: (v) => linear(Number(v), 1, 2), name: "买卖压力" },
  ], 30, missing);

  const chips = weighted([
    { value: holderGrowth, weight: 8, score: (v) => linear(Number(v), 1, 1.35), name: "Holder 增长" },
    { value: freshAcceleration, weight: 5, score: (v) => linear(Number(v), 1, 2), name: "新钱包持续进入" },
    { value: s.effectiveTop10Pct, weight: 5, score: (v) => inverse(Number(v), 0.2, 0.7), name: "有效 Top10" },
    { value: m.devNetFlow1hUsd, weight: 4, score: (v) => inverse(Number(v), 0, -25_000), name: "Dev 行为" },
    { value: m.whaleNetFlow1hUsd, weight: 3, score: (v) => linear(Number(v), -20_000, 50_000), name: "大户净流" },
  ], 25, missing);

  const heat = weighted([
    { value: attentionAcceleration, weight: 10, score: (v) => linear(Number(v), 1, 3), name: "注意力增速" },
    { value: m.crossSourceCount, weight: 5, score: (v) => linear(Number(v), 1, 3), name: "跨来源验证" },
    { value: m.boostAmount, weight: 3, score: (v) => linear(Number(v), 0, 100), name: "DEX Boost" },
    { value: m.profileAvailable, weight: 2, score: (v) => v === true ? 1 : 0, name: "资料完整度" },
  ], 20, missing);

  const priceRun = Math.max(m.priceChange15mPct ?? 0, m.priceChange1hPct ?? 0);
  const overheated = priceRun >= 180 || (m.priceChange5mPct ?? 0) >= 80;
  const structure = weighted([
    { value: lpMc, weight: 5, score: (v) => 1 - Math.abs(clamp(Number(v), 0.05, 0.5) - 0.25) / 0.25, name: "LP/市值" },
    { value: m.liquidityUsd, weight: 4, score: (v) => linear(Number(v), 20_000, 150_000), name: "流动性深度" },
    { value: priceRun, weight: 3, score: (v) => Number(v) < -20 ? 0 : Number(v) <= 80 ? 1 : inverse(Number(v), 80, 220), name: "非抛物线价格" },
    { value: m.consecutiveScans, weight: 3, score: (v) => linear(Number(v), 1, 3), name: "数据连续性" },
  ], 15, missing);

  const safetyQuality = weighted([
    { value: s.openSource, weight: 2, score: (v) => v === true ? 1 : 0, name: "合约开源" },
    { value: s.creatorPct, weight: 2, score: (v) => inverse(Number(v), 0.01, 0.15), name: "创建者持仓" },
    { value: s.lpLockedPct, weight: 2, score: (v) => linear(Number(v), 0.2, 1), name: "LP 锁定" },
    { value: s.buyTax, weight: 2, score: (v) => inverse(Number(v), 0.03, 0.2), name: "买入税" },
    { value: s.sellTax, weight: 2, score: (v) => inverse(Number(v), 0.03, 0.2), name: "卖出税" },
  ], 10, missing);

  const components = { funds: funds.points, chips: chips.points, heat: heat.points, structure: structure.points, safety: safetyQuality.points };
  const total = Math.round(Object.values(components).reduce((sum, value) => sum + value, 0));
  const available = funds.available + chips.available + heat.available + structure.available + safetyQuality.available;
  const coverage = Math.round((available / 100) * 100);
  const eligible = isEligible(input);
  const baseLevel: SignalLevel = total >= 80 ? "ALPHA_SIGNAL" : total >= 65 ? "ALPHA_WATCH" : total >= 50 ? "OBSERVE" : "NOISE";
  let level: SignalLevel = baseLevel;
  if (security.status === "FAIL") level = "RISK_FAIL";
  else if (overheated) level = "OVERHEATED";
  else if (!eligible && (level === "ALPHA_SIGNAL" || level === "ALPHA_WATCH")) level = "OBSERVE";
  else if (level === "ALPHA_SIGNAL" && (security.status !== "PASS" || coverage < 80 || (m.consecutiveScans ?? 0) < 2)) level = "ALPHA_WATCH";

  const alphaInflection = Boolean(
    input.ageMinutes < 24 * 60 &&
    (m.marketCapUsd ?? Infinity) < 2_000_000 &&
    components.funds >= 21 &&
    components.chips >= 16 &&
    components.heat >= 12 &&
    security.status === "PASS" &&
    !overheated &&
    (holderGrowth ?? 0) > 1 &&
    (buyerAcceleration ?? 0) > 1 &&
    (volumeAcceleration ?? 0) > 1
  );

  const reasons = [
    ...security.reasons,
    ...(alphaInflection ? ["资金、筹码与注意力同步加速，价格尚未抛物线"] : []),
    ...(eligible ? [] : ["未满足当前通道准入阈值"]),
    ...(overheated ? ["短周期涨幅过热，等待结构修复"] : []),
  ];

  return { total, coverage, securityStatus: security.status, level, components, alphaInflection, eligible, overheated, reasons, missing: [...new Set(missing)] };
}

export const scoreHelpers = { clamp, linear, inverse, ratio };
