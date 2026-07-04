// regionFirestore.test.ts
// regionFirestore.ts is a thin Admin SDK wrapper with no business logic of
// its own (all math is in regionAggregate.ts, already covered). Its two
// functions (fetchTouchedDocs, writePrunedCounts) are direct passthroughs to
// live Firestore reads/writes and are exercised for real by the pipeline's
// first live workflow_dispatch run (same validation approach lever 4 used —
// see project_playback_reliability_crosscheck memory, "DEPLOYED +
// LIVE-VALIDATED"). This file pins splitDocId's actual parsing contract
// against the document-id shape the app's firestore.rules enforces on write
// (`^[a-zA-Z0-9._-]+_[A-Z]{2}$`), so a future refactor of either side can't
// silently drift the id format apart.

import { describe, test, expect } from "vitest";
import { splitDocId } from "../src/regionAggregate";

describe("splitDocId (channelReputation document id shape)", () => {
  test("splits a valid id into provider channel id and region", () => {
    expect(splitDocId("CNNInternational.us_IN")).toEqual({ id: "CNNInternational.us", region: "IN" });
  });

  test("region must be uppercase — a lowercase suffix does not match", () => {
    expect(splitDocId("cnn.us_in")).toBeNull();
  });

  test("region must be exactly 2 letters — a 3-letter suffix does not match", () => {
    expect(splitDocId("cnn.us_USA")).toBeNull();
  });

  test("an id with no region suffix at all does not match", () => {
    expect(splitDocId("no-underscore-here")).toBeNull();
  });
});
