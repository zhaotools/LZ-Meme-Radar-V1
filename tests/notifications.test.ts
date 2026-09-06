import { describe, expect, it } from "vitest";
import type { RadarToken } from "../src/shared/types";
import { detectAlertEvents, notificationHelpers } from "../worker/notifications";

function token(): RadarToken {
  return {
    chainId: "56", address: "0x1111111111111111111111111111111111111111", name: "Test", symbol: "TEST",
    source: "fixture", lane: "dex", discoveredAt: "2026-09-06T00:00:00Z", observedAt: "2026-09-06T01:00:00Z", ageMinutes: 60,
    metrics: { marketCapUsd: 200_000, liquidityUsd: 50_000, volume1hUsd: 80_000 }, security: {},
    score: {
      total: 70, coverage: 85, securityStatus: "PASS", level: "ALPHA_WATCH",
      components: { funds: 20, chips: 17, heat: 14, structure: 11, safety: 8 },
      alphaInflection: false, eligible: true, overheated: false, reasons: [], missing: [],
    },
  };
}

describe("alert detection", () => {
  it("emits the first watch transition", () => {
    expect(detectAlertEvents(token(), null).map((event) => event.type)).toContain("FIRST_ALPHA_WATCH");
  });

  it("detects score, liquidity and safety deterioration independently", () => {
    const previous = token();
    previous.score.total = 60;
    previous.score.securityStatus = "PASS";
    previous.metrics.liquidityUsd = 100_000;
    const current = token();
    current.score.total = 74;
    current.score.securityStatus = "UNKNOWN";
    current.metrics.liquidityUsd = 60_000;
    const types = detectAlertEvents(current, previous).map((event) => event.type);
    expect(types).toContain("SCORE_JUMP");
    expect(types).toContain("LIQUIDITY_DROP");
    expect(types).toContain("SAFETY_DOWNGRADE");
  });
});

describe("quiet hours", () => {
  it("supports quiet windows that cross midnight", () => {
    const env = { QUIET_HOURS: "23:00-08:00", ALERT_TIMEZONE_OFFSET: "8" } as never;
    expect(notificationHelpers.inQuietHours(env, new Date("2026-09-05T16:30:00Z"))).toBe(true);
    expect(notificationHelpers.inQuietHours(env, new Date("2026-09-06T04:00:00Z"))).toBe(false);
  });
});
