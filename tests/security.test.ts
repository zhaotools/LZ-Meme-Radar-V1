import { describe, expect, it } from "vitest";
import { normalizeGoPlus } from "../worker/security";

describe("GoPlus liquidity normalization", () => {
  it("does not treat concentrated-liquidity NFT positions as unlocked V2 LP", () => {
    const facts = normalizeGoPlus({
      dex: [{ liquidity_type: "UniV3", name: "PancakeV3" }],
      lp_holders: [{ address: "0x1111111111111111111111111111111111111111", percent: "1", is_locked: 0 }],
    });
    expect(facts.lpLockedPct).toBeNull();
  });

  it("keeps the locked percentage for fungible V2 LP tokens", () => {
    const facts = normalizeGoPlus({
      dex: [{ liquidity_type: "UniV2", name: "PancakeV2" }],
      lp_holders: [{ address: "0x1111111111111111111111111111111111111111", percent: "0.8", is_locked: 1 }],
    });
    expect(facts.lpLockedPct).toBe(0.8);
  });
});
