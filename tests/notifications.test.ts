import { afterEach, describe, expect, it, vi } from "vitest";
import type { RadarToken } from "../src/shared/types";
import { detectAlertEvents, notificationHelpers, sendTelegramTest } from "../worker/notifications";

afterEach(() => vi.unstubAllGlobals());

function token(): RadarToken {
  return {
    chainId: "56", address: "0x1111111111111111111111111111111111111111", name: "Test", symbol: "TEST",
    source: "fixture", lane: "dex", discoveredAt: "2026-09-06T00:00:00Z", observedAt: "2026-09-06T01:00:00Z", ageMinutes: 60,
    metrics: { marketCapUsd: 200_000, liquidityUsd: 50_000, volume1hUsd: 80_000 }, security: {},
    score: {
      total: 70, coverage: 85, securityStatus: "PASS", level: "ALPHA_WATCH",
      components: { funds: 20, chips: 17, heat: 14, structure: 11, safety: 8 },
      alphaInflection: false, eligible: true, overheated: false, track: "EARLY_ALPHA",
      breakout: false, riskFlags: [], reasons: [], missing: [],
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

  it("emits one highest market-cap breakout event", () => {
    const previous = token();
    previous.metrics.marketCapUsd = 4_900_000;
    const current = token();
    current.metrics.marketCapUsd = 22_000_000;
    const types = detectAlertEvents(current, previous).map((event) => event.type);
    expect(types).toContain("MC_BREAKOUT_20M");
    expect(types).not.toContain("MC_BREAKOUT_5M");
    expect(types).not.toContain("MC_BREAKOUT_10M");
  });
});

describe("quiet hours", () => {
  it("supports quiet windows that cross midnight", () => {
    const env = { QUIET_HOURS: "23:00-08:00", ALERT_TIMEZONE_OFFSET: "8" } as never;
    expect(notificationHelpers.inQuietHours(env, new Date("2026-09-05T16:30:00Z"))).toBe(true);
    expect(notificationHelpers.inQuietHours(env, new Date("2026-09-06T04:00:00Z"))).toBe(false);
  });
});

describe("Telegram test notification", () => {
  it("sends an explicit test message even while alerts are in shadow mode", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
      ok: true,
      result: { message_id: 42 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramTest({
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_CHAT_ID: "123456",
      ALERT_MODE: "shadow",
    } as never, new Date("2026-09-06T16:00:00Z"));

    expect(result).toMatchObject({ ok: true, messageId: 42 });
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.chat_id).toBe("123456");
    expect(payload.text).toContain("通知测试成功");
    expect(payload.text).toContain("不代表真实 Alpha 信号");
  });
});
