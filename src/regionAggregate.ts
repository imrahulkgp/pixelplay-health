// regionAggregate.ts
// Pure aggregation math for lever 5 (region-bucketed crowd reputation).
// See docs/superpowers/specs/2026-07-04-region-crowd-reputation-design.md §5
// in the PixelPlay app repo for full rationale.

export interface DayCount {
  s: number;
  f: number;
}

/** Keyed by "YYYY-MM-DD" (UTC). */
export type DailyCounts = Record<string, DayCount>;

function daysBetween(dateKey: string, asOf: Date): number {
  const bucketDate = new Date(`${dateKey}T00:00:00Z`);
  const diffMs = asOf.getTime() - bucketDate.getTime();
  return diffMs / (24 * 60 * 60 * 1000);
}

/** Sums `s`/`f` across all buckets within `windowDays` of `asOf` (inclusive of the boundary day). */
export function sumTrailingWindow(counts: DailyCounts, asOf: Date, windowDays: number): DayCount {
  let s = 0;
  let f = 0;
  for (const [dateKey, count] of Object.entries(counts)) {
    if (daysBetween(dateKey, asOf) <= windowDays) {
      s += count.s;
      f += count.f;
    }
  }
  return { s, f };
}

/** True when total reports (s + f) meet the minimum sample floor. */
export function isEligible(sums: DayCount, floor: number): boolean {
  return sums.s + sums.f >= floor;
}

/** True when the failure rate is at/above `threshold`. False on zero total (avoids divide-by-zero). */
export function isRisky(sums: DayCount, threshold: number): boolean {
  const total = sums.s + sums.f;
  if (total === 0) return false;
  return sums.f / total >= threshold;
}

/** Returns a copy of `counts` with buckets older than `windowDays` removed. */
export function pruneOldBuckets(counts: DailyCounts, asOf: Date, windowDays: number): DailyCounts {
  const pruned: DailyCounts = {};
  for (const [dateKey, count] of Object.entries(counts)) {
    if (daysBetween(dateKey, asOf) <= windowDays) {
      pruned[dateKey] = count;
    }
  }
  return pruned;
}

/** A document read from Firestore's `channelReputation` collection. */
export interface ReputationDoc {
  id: string; // Firestore document id, e.g. "CNNInternational.us_IN"
  dailyCounts: DailyCounts;
  lastUpdatedMillis: number;
}

export interface PairOutput {
  id: string; // raw provider channel id, e.g. "CNNInternational.us"
  region: string;
  sums: DayCount;
  /** When this entry was last touched by a real write. A pair that receives
   * no new writes for `windowDays` ages out of `riskyPairs` on its own even
   * without being re-read (see the staleness check in buildOutput below) —
   * this is what makes "no reports for 14 days -> clean slate" true for a
   * channel that simply stops being played, not just one with new successes. */
  lastUpdatedMillis: number;
}

export interface BuildOutputResult {
  outputByPairId: Record<string, PairOutput>;
  riskyPairs: { id: string; region: string }[];
  prunedWrites: { docId: string; prunedCounts: DailyCounts }[];
  maxLastUpdatedMillis: number;
}

function splitDocId(docId: string): { id: string; region: string } | null {
  const match = docId.match(/^(.+)_([A-Z]{2})$/);
  if (!match) return null;
  return { id: match[1]!, region: match[2]! };
}

/**
 * The core per-run orchestration, kept pure (no I/O) so it's fully unit
 * testable: given the docs touched since the last run and the PRIOR
 * cumulative output, produces the NEW cumulative output. Each touched doc's
 * entry is a full REPLACE (never an additive merge) of its prior entry, so
 * re-reading the same doc twice — e.g. after a cursor edge case — always
 * yields the same result, never a doubled one. Docs not touched this run
 * keep whatever entry they already had in `prevOutputByPairId`.
 */
export function buildOutput(
  touched: ReputationDoc[],
  prevOutputByPairId: Record<string, PairOutput>,
  now: Date,
  windowDays: number,
  sampleFloor: number,
  riskThreshold: number,
  cursorFloorMillis: number
): BuildOutputResult {
  const outputByPairId = { ...prevOutputByPairId };
  const prunedWrites: { docId: string; prunedCounts: DailyCounts }[] = [];
  let maxLastUpdatedMillis = cursorFloorMillis;

  for (const doc of touched) {
    const split = splitDocId(doc.id);
    if (!split) continue; // malformed doc id — skip rather than crash

    const sums = sumTrailingWindow(doc.dailyCounts, now, windowDays);
    outputByPairId[doc.id] = { id: split.id, region: split.region, sums, lastUpdatedMillis: doc.lastUpdatedMillis };

    const pruned = pruneOldBuckets(doc.dailyCounts, now, windowDays);
    if (JSON.stringify(pruned) !== JSON.stringify(doc.dailyCounts)) {
      prunedWrites.push({ docId: doc.id, prunedCounts: pruned });
    }

    if (doc.lastUpdatedMillis > maxLastUpdatedMillis) maxLastUpdatedMillis = doc.lastUpdatedMillis;
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const riskyPairs = Object.values(outputByPairId)
    .filter((entry) => {
      // A pair that hasn't been touched by a real write in `windowDays` ages
      // out on its own, even though nothing re-read/re-summed it this run —
      // this is what makes "no reports for 14 days -> clean slate" true for
      // a channel that simply stops being played, not just one that
      // accumulates new successes. Without this check, a pair's last-known
      // sums would stay in riskyPairs forever once it stops receiving ANY
      // writes, since only touched docs get their sums recomputed.
      const daysSinceTouch = (now.getTime() - entry.lastUpdatedMillis) / msPerDay;
      if (daysSinceTouch > windowDays) return false;
      return isEligible(entry.sums, sampleFloor) && isRisky(entry.sums, riskThreshold);
    })
    .map((entry) => ({ id: entry.id, region: entry.region }));

  return { outputByPairId, riskyPairs, prunedWrites, maxLastUpdatedMillis };
}
