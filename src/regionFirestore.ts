// regionFirestore.ts
// Thin Admin SDK wrapper for lever 5. All aggregation math AND the
// ReputationDoc type live in regionAggregate.ts (pure, unit-tested); this
// file only does I/O, so it doesn't define a competing duplicate type.
// Admin SDK access bypasses Firestore Security Rules entirely — this is
// the intended mechanism (see spec §4/§5), not a workaround.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { DailyCounts, ReputationDoc } from "./regionAggregate";

function db() {
  if (getApps().length === 0) {
    const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!key) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY is not set");
    initializeApp({ credential: cert(JSON.parse(key)) });
  }
  return getFirestore();
}

/** Docs whose lastUpdated is strictly after `cursorMillis`. Bounds read cost to write activity since the last run. */
export async function fetchTouchedDocs(cursorMillis: number): Promise<ReputationDoc[]> {
  const snapshot = await db()
    .collection("channelReputation")
    .where("lastUpdated", ">", Timestamp.fromMillis(cursorMillis))
    .get();
  return snapshot.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      dailyCounts: (data.dailyCounts ?? {}) as DailyCounts,
      lastUpdatedMillis: (data.lastUpdated as Timestamp)?.toMillis() ?? 0,
    };
  });
}

/**
 * Overwrites a document's dailyCounts with a pruned map, WITHOUT touching
 * lastUpdated — so this write never makes the doc spuriously reappear as
 * "touched" on the next run's cursor query (spec §5 step 4).
 */
export async function writePrunedCounts(docId: string, prunedCounts: DailyCounts): Promise<void> {
  await db().collection("channelReputation").doc(docId).update({ dailyCounts: prunedCounts });
}
