import { describe, expect, it } from "vitest";
import { fourApiRowToCandidate } from "../worker/discovery";

describe("Four.meme discovery normalization", () => {
  it("keeps the token ticker separate from the quote symbol", () => {
    const candidate = fourApiRowToCandidate("PROGRESS", {
      tokenAddress: "0x1234567890123456789012345678901234567890",
      name: "牛来",
      shortName: "NIULAI",
      symbol: "BNB",
      status: "PUBLISH",
      createDate: "1788688439000",
      cap: "43853.75",
      hourVol: "1065.42",
      hold: 331,
      progress: "0.9459",
      min5Increase: "0.02",
      hourIncrease: "0.25",
    }, new Date("2026-09-06T08:00:00Z"));
    expect(candidate?.symbol).toBe("NIULAI");
    expect(candidate?.lane).toBe("launchpad");
    expect(candidate?.initialMetrics?.marketCapUsd).toBe(43853.75);
    expect(candidate?.initialMetrics?.priceChange1hPct).toBe(25);
    expect(candidate?.initialMetrics?.curveProgressPct).toBeCloseTo(0.9459);
  });

  it("moves graduated Four.meme tokens to the DEX lane", () => {
    const candidate = fourApiRowToCandidate("HOT", {
      tokenAddress: "0x1234567890123456789012345678901234567890",
      name: "Graduated",
      shortName: "DEX",
      status: "TRADE",
    });
    expect(candidate?.lane).toBe("dex");
  });
});
