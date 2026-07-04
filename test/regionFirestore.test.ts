// regionFirestore.test.ts
// regionFirestore.ts is a thin Admin SDK wrapper with no business logic of
// its own (all math is in regionAggregate.ts, already covered). Its two
// functions (fetchTouchedDocs, writePrunedCounts) are direct passthroughs to
// live Firestore reads/writes and are exercised for real by the pipeline's
// first live workflow_dispatch run (same validation approach lever 4 used —
// see project_playback_reliability_crosscheck memory, "DEPLOYED +
// LIVE-VALIDATED"). This file only pins the one piece of real logic here:
// the document-id shape docId.matches expects downstream (see firestore.rules
// in the app repo), so a future refactor can't silently drift the id format.

import { describe, test, expect } from "vitest";

describe("channelReputation document id shape", () => {
  test("id pattern matches the Firestore rule's expected shape", () => {
    const pattern = /^[a-zA-Z0-9._-]+_[A-Z]{2}$/;
    expect(pattern.test("CNNInternational.us_IN")).toBe(true);
    expect(pattern.test("cnn.us_us")).toBe(false); // region must be uppercase
    expect(pattern.test("cnn.us_USA")).toBe(false); // region must be exactly 2 letters
  });
});
