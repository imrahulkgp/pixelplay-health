import { describe, it, expect } from "vitest";
import { groupByChannel, fetchJson } from "../src/catalog";
import type { Stream } from "../src/types";
import type { FetchFn } from "../src/probe";

describe("groupByChannel", () => {
  const streams: Stream[] = [
    { channel: "cnn.us", url: "https://a/1.m3u8" },
    { channel: "cnn.us", url: "https://a/2.m3u8" },
    { channel: "bbc.uk", url: "https://b/1.m3u8" },
    { channel: null, url: "https://c/unlinked.m3u8" }, // unlinked -> dropped
    { channel: "blocked.xx", url: "https://d/1.m3u8" }, // blocklisted -> dropped
  ];
  it("groups linked, non-blocked channels and drops the rest", () => {
    const out = groupByChannel(streams, new Set(["blocked.xx"]));
    expect(Object.keys(out).sort()).toEqual(["bbc.uk", "cnn.us"]);
    expect(out["cnn.us"]!.length).toBe(2);
  });
});

describe("fetchJson retry/backoff (injected sleep keeps the test instant)", () => {
  const noSleep = async () => {};
  // returns the i-th status (clamped), so [429,429,200] = fail, fail, succeed
  function seqFetch(statuses: number[], body = "[]"): FetchFn {
    let i = 0;
    return async (url: string) => {
      const status = statuses[Math.min(i++, statuses.length - 1)]!;
      return { status, url, text: async () => body };
    };
  }
  it("retries past 429s then succeeds", async () => {
    const out = await fetchJson<number[]>("u", seqFetch([429, 429, 200], "[1,2]"), noSleep);
    expect(out).toEqual([1, 2]);
  });
  it("throws after 4 failed attempts (persistent 429)", async () => {
    await expect(fetchJson("u", seqFetch([429]), noSleep)).rejects.toThrow();
  });
});
