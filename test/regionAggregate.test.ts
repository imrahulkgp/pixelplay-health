import { describe, test, expect } from "vitest";
import { sumTrailingWindow, isEligible, isRisky, pruneOldBuckets, buildOutput } from "../src/regionAggregate";
import type { DailyCounts } from "../src/regionAggregate";

const asOf = new Date("2026-07-14T00:00:00Z"); // fixed "now" for deterministic window math

describe("sumTrailingWindow", () => {
  test("sums counts within the trailing window", () => {
    const counts: DailyCounts = {
      "2026-07-14": { s: 1, f: 2 },
      "2026-07-10": { s: 0, f: 1 },
    };
    expect(sumTrailingWindow(counts, asOf, 14)).toEqual({ s: 1, f: 3 });
  });

  test("excludes buckets older than the window", () => {
    const counts: DailyCounts = {
      "2026-07-14": { s: 1, f: 0 },
      "2026-06-01": { s: 0, f: 10 }, // 43 days old, outside a 14-day window
    };
    expect(sumTrailingWindow(counts, asOf, 14)).toEqual({ s: 1, f: 0 });
  });

  test("a document with all buckets older than the window sums to zero", () => {
    const counts: DailyCounts = { "2026-01-01": { s: 5, f: 5 } };
    expect(sumTrailingWindow(counts, asOf, 14)).toEqual({ s: 0, f: 0 });
  });

  test("exactly at the window boundary (14 days ago) is included", () => {
    const counts: DailyCounts = { "2026-06-30": { s: 1, f: 0 } }; // exactly 14 days before asOf
    expect(sumTrailingWindow(counts, asOf, 14)).toEqual({ s: 1, f: 0 });
  });

  test("empty map sums to zero", () => {
    expect(sumTrailingWindow({}, asOf, 14)).toEqual({ s: 0, f: 0 });
  });
});

describe("isEligible (minimum sample floor)", () => {
  test("2 total reports is not eligible", () => {
    expect(isEligible({ s: 1, f: 1 }, 3)).toBe(false);
  });
  test("exactly 3 total reports is eligible", () => {
    expect(isEligible({ s: 1, f: 2 }, 3)).toBe(true);
  });
  test("more than 3 is eligible", () => {
    expect(isEligible({ s: 5, f: 5 }, 3)).toBe(true);
  });
});

describe("isRisky (failure-rate threshold)", () => {
  test("failure rate of exactly 0.5 is risky", () => {
    expect(isRisky({ s: 2, f: 2 }, 0.5)).toBe(true);
  });
  test("failure rate of 0.49 is not risky", () => {
    // 49/100 = 0.49
    expect(isRisky({ s: 51, f: 49 }, 0.5)).toBe(false);
  });
  test("failure rate above 0.5 is risky", () => {
    expect(isRisky({ s: 1, f: 3 }, 0.5)).toBe(true);
  });
  test("zero total reports is not risky (avoid divide-by-zero)", () => {
    expect(isRisky({ s: 0, f: 0 }, 0.5)).toBe(false);
  });
});

describe("pruneOldBuckets", () => {
  test("removes buckets older than the window, keeps the rest", () => {
    const counts: DailyCounts = {
      "2026-07-14": { s: 1, f: 0 },
      "2026-06-01": { s: 0, f: 10 },
    };
    expect(pruneOldBuckets(counts, asOf, 14)).toEqual({ "2026-07-14": { s: 1, f: 0 } });
  });

  test("no-op when nothing is old enough to prune", () => {
    const counts: DailyCounts = { "2026-07-14": { s: 1, f: 0 } };
    expect(pruneOldBuckets(counts, asOf, 14)).toEqual(counts);
  });

  test("empty map stays empty", () => {
    expect(pruneOldBuckets({}, asOf, 14)).toEqual({});
  });
});

describe("buildOutput (orchestration, still pure — no I/O)", () => {
  const doc = (id: string, dailyCounts: DailyCounts, lastUpdatedMillis: number) => ({ id, dailyCounts, lastUpdatedMillis });
  const touchedNow = asOf.getTime(); // "just written" — well within any window, so tests below exercise
                                      // the floor/threshold/pruning logic they claim to, not accidentally
                                      // tripping the staleness gate (a doc timestamped near the 1970 epoch
                                      // would be ~20,000 days stale relative to `asOf` and get excluded
                                      // regardless of its sums, which would make these tests pass for the
                                      // wrong reason — or fail outright where they should pass).

  test("a touched eligible+risky doc appears in riskyPairs with id/region split from the doc id", () => {
    const touched = [doc("CNNInternational.us_IN", { "2026-07-14": { s: 1, f: 2 } }, touchedNow)];
    const result = buildOutput(touched, {}, asOf, 14, 3, 0.5, 0);
    expect(result.riskyPairs).toEqual([{ id: "CNNInternational.us", region: "IN" }]);
  });

  test("a doc below the sample floor does not appear in riskyPairs", () => {
    const touched = [doc("CNNInternational.us_IN", { "2026-07-14": { s: 0, f: 1 } }, touchedNow)];
    const result = buildOutput(touched, {}, asOf, 14, 3, 0.5, 0);
    expect(result.riskyPairs).toEqual([]);
  });

  test("re-reading the same document twice in sequence yields the same output entry both times, not doubled", () => {
    const touched = [doc("CNNInternational.us_IN", { "2026-07-14": { s: 1, f: 2 } }, touchedNow)];
    const firstRun = buildOutput(touched, {}, asOf, 14, 3, 0.5, 0);
    const secondRun = buildOutput(touched, firstRun.outputByPairId, asOf, 14, 3, 0.5, firstRun.maxLastUpdatedMillis);
    expect(secondRun.outputByPairId["CNNInternational.us_IN"]).toEqual(firstRun.outputByPairId["CNNInternational.us_IN"]);
    expect(secondRun.riskyPairs).toEqual(firstRun.riskyPairs);
  });

  test("a doc not touched this run keeps its prior output entry and still counts as risky if within the window", () => {
    const recentlyTouchedMillis = asOf.getTime() - 5 * 24 * 60 * 60 * 1000; // 5 days ago, within 14d window
    const prevOutput = {
      "OldChannel.uk_GB": { id: "OldChannel.uk", region: "GB", sums: { s: 0, f: 3 }, lastUpdatedMillis: recentlyTouchedMillis },
    };
    const result = buildOutput([], prevOutput, asOf, 14, 3, 0.5, 500);
    expect(result.outputByPairId).toEqual(prevOutput);
    expect(result.riskyPairs).toEqual([{ id: "OldChannel.uk", region: "GB" }]);
  });

  test("a pair with no new writes for longer than the window ages out of riskyPairs even though nothing re-read it", () => {
    const staleTouchedMillis = asOf.getTime() - 20 * 24 * 60 * 60 * 1000; // 20 days ago, past the 14d window
    const prevOutput = {
      "OldChannel.uk_GB": { id: "OldChannel.uk", region: "GB", sums: { s: 0, f: 3 }, lastUpdatedMillis: staleTouchedMillis },
    };
    const result = buildOutput([], prevOutput, asOf, 14, 3, 0.5, 500);
    // The stale entry is still present in outputByPairId (never deleted, just not surfaced) —
    // matches the spec's "docs are never deleted" lifecycle note.
    expect(result.outputByPairId).toEqual(prevOutput);
    expect(result.riskyPairs).toEqual([]);
  });

  test("a malformed doc id (no valid region suffix) is skipped, not crashed on", () => {
    const touched = [doc("no-underscore-here", { "2026-07-14": { s: 1, f: 2 } }, touchedNow)];
    const result = buildOutput(touched, {}, asOf, 14, 3, 0.5, 0);
    expect(result.outputByPairId).toEqual({});
    expect(result.riskyPairs).toEqual([]);
  });

  test("prunedWrites is populated only when pruning actually changes the map", () => {
    const withOldBucket = { "2026-07-14": { s: 1, f: 0 }, "2026-01-01": { s: 0, f: 5 } };
    const touched = [doc("CNNInternational.us_IN", withOldBucket, touchedNow)];
    const result = buildOutput(touched, {}, asOf, 14, 3, 0.5, 0);
    expect(result.prunedWrites).toEqual([{ docId: "CNNInternational.us_IN", prunedCounts: { "2026-07-14": { s: 1, f: 0 } } }]);
  });

  test("prunedWrites is empty when nothing needs pruning", () => {
    const touched = [doc("CNNInternational.us_IN", { "2026-07-14": { s: 1, f: 0 } }, touchedNow)];
    const result = buildOutput(touched, {}, asOf, 14, 3, 0.5, 0);
    expect(result.prunedWrites).toEqual([]);
  });

  test("maxLastUpdatedMillis advances to the newest touched doc, never regresses below the prior cursor", () => {
    const touched = [doc("A.us_US", { "2026-07-14": { s: 1, f: 2 } }, 500)];
    const result = buildOutput(touched, {}, asOf, 14, 3, 0.5, 1000);
    expect(result.maxLastUpdatedMillis).toBe(1000); // touched doc's 500 is older than the existing cursor floor
  });
});
