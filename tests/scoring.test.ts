import { describe, expect, it } from "vitest";
import { evaluateSecurity, scoreToken } from "../src/shared/scoring";
import type { ScoreInput } from "../src/shared/types";

function strongInput(): ScoreInput {
  return {
    lane: "dex",
    ageMinutes: 360,
    metrics: {
      marketCapUsd: 600_000,
      liquidityUsd: 120_000,
      volume1hUsd: 180_000,
      priorVolume1hUsd: 80_000,
      txBuys1h: 400,
      txSells1h: 190,
      buyers1h: 300,
      priorBuyers1h: 150,
      holders: 1_000,
      priorHolders: 760,
      freshWallets1h: 160,
      priorFreshWallets1h: 70,
      netBuy1hUsd: 90_000,
      whaleNetFlow1hUsd: 40_000,
      devNetFlow1hUsd: 0,
      priceChange5mPct: 8,
      priceChange15mPct: 20,
      priceChange1hPct: 45,
      attention: 90,
      priorAttention: 35,
      crossSourceCount: 3,
      boostAmount: 70,
      profileAvailable: true,
      consecutiveScans: 3,
    },
    security: {
      isHoneypot: false,
      cannotBuy: false,
      cannotSellAll: false,
      maliciousContract: false,
      maliciousCreator: false,
      ownerChangeBalance: false,
      personalSlippageModifiable: false,
      slippageModifiable: false,
      transferPausable: false,
      blacklisted: false,
      mintable: false,
      ownerRenounced: true,
      effectiveTop10Pct: 0.28,
      creatorPct: 0.01,
      lpLockedPct: 0.95,
      openSource: true,
      buyTax: 0.03,
      sellTax: 0.03,
    },
  };
}

describe("security gate", () => {
  it("hard-fails a honeypot regardless of other fields", () => {
    const input = strongInput();
    input.security.isHoneypot = true;
    const result = scoreToken(input);
    expect(result.securityStatus).toBe("FAIL");
    expect(result.level).toBe("RISK_FAIL");
  });

  it("keeps missing security data UNKNOWN", () => {
    const result = evaluateSecurity({ isHoneypot: false });
    expect(result.status).toBe("UNKNOWN");
    expect(result.coverage).toBeLessThan(70);
  });

  it("fails excessive sell tax", () => {
    const input = strongInput();
    input.security.sellTax = 0.3;
    expect(scoreToken(input).level).toBe("RISK_FAIL");
  });
});

describe("alpha scoring", () => {
  it("produces a confirmed signal only with pass security and broad coverage", () => {
    const result = scoreToken(strongInput());
    expect(result.total).toBeGreaterThanOrEqual(80);
    expect(result.coverage).toBeGreaterThanOrEqual(80);
    expect(result.level).toBe("ALPHA_SIGNAL");
    expect(result.alphaInflection).toBe(true);
  });

  it("downgrades the first scan to watch", () => {
    const input = strongInput();
    input.metrics.consecutiveScans = 1;
    expect(scoreToken(input).level).toBe("ALPHA_WATCH");
  });

  it("never emits a signal when security is unknown", () => {
    const input = strongInput();
    input.security = {};
    expect(scoreToken(input).level).not.toBe("ALPHA_SIGNAL");
  });

  it("marks a parabolic move as overheated", () => {
    const input = strongInput();
    input.metrics.priceChange15mPct = 210;
    expect(scoreToken(input).level).toBe("OVERHEATED");
  });

  it("does not let an ineligible micro-pool become a watch signal", () => {
    const input = strongInput();
    input.metrics.liquidityUsd = 5_000;
    const result = scoreToken(input);
    expect(result.eligible).toBe(false);
    expect(["OBSERVE", "NOISE"]).toContain(result.level);
  });
});
