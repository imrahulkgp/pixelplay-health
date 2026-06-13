import { describe, it, expect } from "vitest";
import { buildDeadJson } from "../src/artifacts";
import type { StateMap } from "../src/types";

describe("buildDeadJson", () => {
  it("emits RAW iptv-org provider ids, sorted, only failStreak>=K", () => {
    const state: StateMap = {
      "cnn.us": { failStreak: 2, lastChecked: "", lastSeen: "" },
      "bbc.uk": { failStreak: 1, lastChecked: "", lastSeen: "" }, // below K
      "abc.au": { failStreak: 3, lastChecked: "", lastSeen: "" },
    };
    const out = buildDeadJson(state, new Date("2026-06-13T03:00:00Z"));
    expect(out.schemaVersion).toBe(1);
    expect(out.generatedAt).toBe("2026-06-13T03:00:00.000Z");
    // raw iptv-org ids (e.g. "cnn.us"), not any consumer-side composite id
    expect(out.deadProviderIDs).toEqual(["abc.au", "cnn.us"]);
  });
});
