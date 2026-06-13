import { describe, it, expect } from "vitest";
import { runProbe } from "../src/run";
import type { Stream, StateMap } from "../src/types";
import type { FetchFn } from "../src/probe";

const MEDIA = `#EXTM3U\n#EXTINF:6.0,\nseg0.ts`;

function mockFetch(table: Record<string, { status: number; body?: string }>): FetchFn {
  return async (url: string) => {
    const r = table[url];
    if (!r) { const e: any = new Error("dns"); e.cause = { code: "ENOTFOUND" }; throw e; }
    return { status: r.status, url, text: async () => r.body ?? "" };
  };
}

const aliveTable = {
  "https://h/a.m3u8": { status: 200, body: MEDIA },
  "https://h/seg0.ts": { status: 200 },
};

describe("runProbe (orchestrator)", () => {
  it("lists a hard-dead channel only after K consecutive dead runs", async () => {
    const streams: Stream[] = [{ channel: "dead.xx", url: "https://gone/x.m3u8" }];
    const fetchFn = mockFetch({}); // everything DNS-dead
    let state: StateMap = {};
    let day = new Date("2026-06-13T03:00:00Z");

    let r = await runProbe(streams, new Set(), state, fetchFn, day);
    expect(r.dead.deadProviderIDs).toEqual([]); // streak 1 < K
    state = r.state;

    day = new Date("2026-06-14T03:00:00Z");
    r = await runProbe(streams, new Set(), state, fetchFn, day);
    expect(r.dead.deadProviderIDs).toEqual(["dead.xx"]); // streak 2 == K
  });

  it("resurrects: a listed dead channel drops off the moment it probes alive", async () => {
    const streams: Stream[] = [{ channel: "back.xx", url: "https://h/a.m3u8" }];
    // pre-seed as already-listed dead
    let state: StateMap = { "back.xx": { failStreak: 2, lastChecked: "2026-06-12T03:00:00Z", lastSeen: "2026-06-12T03:00:00Z" } };
    const fetchFn = mockFetch(aliveTable);
    const r = await runProbe(streams, new Set(), state, fetchFn, new Date("2026-06-13T03:00:00Z"));
    expect(r.dead.deadProviderIDs).toEqual([]); // alive -> streak 0 -> dropped
    expect(r.state["back.xx"]!.failStreak).toBe(0);
  });

  it("ignores blocklisted channels entirely", async () => {
    const streams: Stream[] = [{ channel: "blk.xx", url: "https://gone/x.m3u8" }];
    const r = await runProbe(streams, new Set(["blk.xx"]), {}, mockFetch({}), new Date());
    expect(r.dead.deadProviderIDs).toEqual([]);
    expect(r.state["blk.xx"]).toBeUndefined();
  });

  it("low-confidence run does NOT overwrite the dead list", async () => {
    // 100% inconclusive (all 403) -> inconclusiveRate 1.0 >= tripwire
    const streams: Stream[] = Array.from({ length: 5 }, (_, i) => ({ channel: `c${i}.xx`, url: `https://h/${i}.m3u8` }));
    const table = Object.fromEntries(streams.map((s) => [s.url, { status: 403 }]));
    const r = await runProbe(streams, new Set(), {}, mockFetch(table), new Date());
    expect(r.metrics.lowConfidence).toBe(true);
    expect(r.publishDead).toBe(false); // caller must keep last-good dead.json
  });
});
