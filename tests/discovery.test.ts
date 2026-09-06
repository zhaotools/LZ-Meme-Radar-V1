import { describe, expect, it } from "vitest";
import { dexSearchPairsToCandidates, fourApiRowToCandidate, geckoNewPoolsToCandidates } from "../worker/discovery";

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

describe("GeckoTerminal fallback discovery", () => {
  it("normalizes a Four.meme new pool and preserves unique buyer metrics", () => {
    const candidates = geckoNewPoolsToCandidates({
      data: [{
        attributes: {
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          pool_created_at: "2026-09-06T08:00:00Z",
          fdv_usd: "125000",
          reserve_in_usd: "42000",
          base_token_price_usd: "0.000125",
          price_change_percentage: { m5: "2.5", h1: "18", h6: "31" },
          transactions: {
            m5: { buys: 12, sells: 3, buyers: 10, sellers: 3 },
            h1: { buys: 90, sells: 45, buyers: 72, sellers: 38 },
          },
          volume_usd: { m5: "9000", m15: "18000", h1: "52000", h6: "91000", h24: "120000" },
        },
        relationships: {
          base_token: { data: { id: "bsc_0x1234567890123456789012345678901234567890" } },
          quote_token: { data: { id: "bsc_0x0000000000000000000000000000000000000000" } },
          dex: { data: { id: "four-meme" } },
        },
      }],
      included: [{
        id: "bsc_0x1234567890123456789012345678901234567890",
        attributes: { name: "牛来", symbol: "NIULAI", image_url: "https://example.com/niulai.png" },
      }],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].address).toBe("0x1234567890123456789012345678901234567890");
    expect(candidates[0].lane).toBe("launchpad");
    expect(candidates[0].symbol).toBe("NIULAI");
    expect(candidates[0].initialMetrics?.buyers1h).toBe(72);
    expect(candidates[0].initialMetrics?.liquidityUsd).toBe(42000);
  });
});

describe("DEX Screener search fallback", () => {
  it("selects the non-WBNB side and keeps the search pair metrics", () => {
    const candidates = dexSearchPairsToCandidates([{
      chainId: "bsc",
      dexId: "flapsh",
      url: "https://dexscreener.com/bsc/pair",
      pairAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseToken: {
        address: "0x1234567890123456789012345678901234567890",
        name: "牛来",
        symbol: "NIULAI",
      },
      quoteToken: {
        address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        name: "Wrapped BNB",
        symbol: "WBNB",
      },
      priceUsd: "0.001",
      pairCreatedAt: 1_788_688_000_000,
      liquidity: { usd: 75000 },
      volume: { m5: 12000, h1: 88000 },
      txns: { m5: { buys: 30, sells: 12 }, h1: { buys: 140, sells: 55 } },
      priceChange: { m5: 4, h1: 28 },
    }]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].symbol).toBe("NIULAI");
    expect(candidates[0].lane).toBe("launchpad");
    expect(candidates[0].initialMetrics?.volume1hUsd).toBe(88000);
    expect(candidates[0].initialMetrics?.txBuys1h).toBe(140);
  });
});
