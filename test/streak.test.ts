import { describe, it, expect } from "vitest";
import { updateChannel, isDead, prune, K, CADENCE_MS } from "../src/streak";
import type { ChannelState, StateMap } from "../src/types";

const at = (iso: string): Date => new Date(iso);

describe("updateChannel", () => {
  it("DEAD_SIGNAL increments; INCONCLUSIVE holds; ALIVE resets", () => {
    let s: ChannelState | undefined = undefined;
    s = updateChannel(s, "DEAD_SIGNAL", at("2026-06-13T00:00:00Z"), CADENCE_MS);
    expect(s.failStreak).toBe(1);
    s = updateChannel(s, "INCONCLUSIVE", at("2026-06-14T00:00:00Z"), CADENCE_MS);
    expect(s.failStreak).toBe(1);
    s = updateChannel(s, "DEAD_SIGNAL", at("2026-06-15T00:00:00Z"), CADENCE_MS);
    expect(s.failStreak).toBe(2);
    s = updateChannel(s, "ALIVE", at("2026-06-16T00:00:00Z"), CADENCE_MS);
    expect(s.failStreak).toBe(0); // resurrection
  });

  it("resets streak when a channel re-enters after an absence > 2x cadence", () => {
    const prev: ChannelState = { failStreak: 2, lastChecked: "2026-06-01T00:00:00Z", lastSeen: "2026-06-01T00:00:00Z" };
    // returns 12 days later, still dead this run
    const s = updateChannel(prev, "DEAD_SIGNAL", at("2026-06-13T00:00:00Z"), CADENCE_MS);
    expect(s.failStreak).toBe(1); // reset to 0 then +1, NOT 3
  });
});

describe("isDead", () => {
  it("lists at K", () => {
    expect(isDead({ failStreak: K, lastChecked: "", lastSeen: "" })).toBe(true);
    expect(isDead({ failStreak: K - 1, lastChecked: "", lastSeen: "" })).toBe(false);
  });
});

describe("prune", () => {
  it("drops channels not seen within 30 days", () => {
    const state: StateMap = {
      fresh: { failStreak: 1, lastChecked: "", lastSeen: "2026-06-12T00:00:00Z" },
      stale: { failStreak: 1, lastChecked: "", lastSeen: "2026-04-01T00:00:00Z" },
    };
    const out = prune(state, at("2026-06-13T00:00:00Z"));
    expect(Object.keys(out)).toEqual(["fresh"]);
  });
});
