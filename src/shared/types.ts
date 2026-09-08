export type RadarLane = "launchpad" | "dex";
export type RadarTrack = "LAUNCHPAD" | "EARLY_ALPHA" | "MOMENTUM_BREAKOUT";
export type SecurityStatus = "PASS" | "UNKNOWN" | "FAIL";
export type SignalLevel = "NOISE" | "OBSERVE" | "ALPHA_WATCH" | "ALPHA_SIGNAL" |
  "BREAKOUT_WATCH" | "BREAKOUT_SIGNAL" | "OVERHEATED" | "RISK_FAIL";
export type SourceHealthStatus = "ok" | "degraded" | "error" | "disabled";

export interface SecurityFacts {
  isHoneypot?: boolean | null;
  cannotBuy?: boolean | null;
  cannotSellAll?: boolean | null;
  maliciousContract?: boolean | null;
  maliciousCreator?: boolean | null;
  ownerChangeBalance?: boolean | null;
  personalSlippageModifiable?: boolean | null;
  slippageModifiable?: boolean | null;
  transferPausable?: boolean | null;
  blacklisted?: boolean | null;
  mintable?: boolean | null;
  hiddenOwner?: boolean | null;
  ownerRenounced?: boolean | null;
  buyTax?: number | null;
  sellTax?: number | null;
  effectiveTop10Pct?: number | null;
  creatorPct?: number | null;
  lpLockedPct?: number | null;
  openSource?: boolean | null;
}

export interface RadarMetrics {
  priceUsd?: number | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  liquidityChangePct?: number | null;
  volume5mUsd?: number | null;
  volume15mUsd?: number | null;
  volume1hUsd?: number | null;
  volume6hUsd?: number | null;
  volume24hUsd?: number | null;
  priorVolume1hUsd?: number | null;
  priorMarketCapUsd?: number | null;
  priorLiquidityUsd?: number | null;
  marketCapChangePct?: number | null;
  buys5m?: number | null;
  sells5m?: number | null;
  txBuys1h?: number | null;
  txSells1h?: number | null;
  buyers1h?: number | null;
  priorBuyers1h?: number | null;
  sellers1h?: number | null;
  holders?: number | null;
  priorHolders?: number | null;
  freshWallets1h?: number | null;
  priorFreshWallets1h?: number | null;
  netBuy1hUsd?: number | null;
  whaleNetFlow1hUsd?: number | null;
  devNetFlow1hUsd?: number | null;
  priceChange5mPct?: number | null;
  priceChange15mPct?: number | null;
  priceChange1hPct?: number | null;
  priceChange6hPct?: number | null;
  attention?: number | null;
  priorAttention?: number | null;
  crossSourceCount?: number | null;
  boostAmount?: number | null;
  profileAvailable?: boolean | null;
  curveProgressPct?: number | null;
  raisedBnb?: number | null;
  consecutiveScans?: number | null;
}

export interface ScoreComponents {
  funds: number;
  chips: number;
  heat: number;
  structure: number;
  safety: number;
}

export interface ScoreResult {
  total: number;
  coverage: number;
  securityStatus: SecurityStatus;
  level: SignalLevel;
  components: ScoreComponents;
  alphaInflection: boolean;
  eligible: boolean;
  overheated: boolean;
  track: RadarTrack;
  breakout: boolean;
  riskFlags: string[];
  reasons: string[];
  missing: string[];
}

export interface RadarToken {
  chainId: "56";
  address: string;
  pairAddress?: string | null;
  name: string;
  symbol: string;
  imageUrl?: string | null;
  source: string;
  lane: RadarLane;
  track?: RadarTrack;
  tokenCreatedAt?: string | null;
  firstSeenAt?: string;
  discoveredAt: string;
  observedAt: string;
  pairCreatedAt?: string | null;
  discoveryLatencySeconds?: number | null;
  ageMinutes: number;
  metrics: RadarMetrics;
  security: SecurityFacts;
  score: ScoreResult;
  dexUrl?: string | null;
  fourUrl?: string | null;
  fieldSources?: Record<string, string>;
}

export interface RadarSummary {
  discovered24h: number;
  riskPass: number;
  alphaWatch: number;
  alphaSignal: number;
  breakoutWatch: number;
  breakoutSignal: number;
  alertsSent: number;
}

export interface RadarResponse {
  generatedAt: string;
  sourceMode: "live" | "demo";
  scanStatus: "ok" | "partial" | "error";
  summary: RadarSummary;
  tokens: RadarToken[];
  sourceHealth?: SourceHealth[];
  latestScan?: ScanRunSummary | null;
  notices?: string[];
}

export interface SourceHealth {
  source: string;
  status: SourceHealthStatus;
  lastAttemptAt: string;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  candidateCount: number;
  latencyMs: number;
}

export interface ScanRunSummary {
  id: string;
  startedAt: string;
  finishedAt?: string | null;
  status: "running" | "ok" | "partial" | "error";
  discoveredCount: number;
  queuedCount: number;
  trackedCount: number;
  scoredCount: number;
  alertCount: number;
  error?: string | null;
}

export interface ScoreInput {
  lane: RadarLane;
  ageMinutes: number;
  metrics: RadarMetrics;
  security: SecurityFacts;
}
