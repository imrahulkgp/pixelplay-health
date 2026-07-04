// regionMain.ts
// Entrypoint for the lever-5 region-reputation aggregation job. Mirrors
// main.ts's read-state / do-work / write-state / publish shape. All the
// actual orchestration logic (replace-not-merge, pruning, floor/threshold
// filtering) lives in the pure, unit-tested buildOutput() — this file is
// just I/O glue, matching the split already proven in regionFirestore.ts.
//
// Artifacts live at the ROOT of the orphan `data-region` branch (a
// DIFFERENT branch from `data`, deliberately — see spec §5 for why sharing
// `data` with the existing daily probe's orphan force-push would wipe one
// or the other's files on every run).

import { readFile, writeFile } from "node:fs/promises";
import { fetchTouchedDocs, writePrunedCounts } from "./regionFirestore";
import { buildOutput } from "./regionAggregate";
import type { PairOutput } from "./regionAggregate";

const STATE_PATH = "regionState.json";
const OUTPUT_PATH = "regionReputation.json";
const WINDOW_DAYS = 14;
const SAMPLE_FLOOR = 3;
const RISK_THRESHOLD = 0.5;
const SCHEMA_VERSION = 1;

interface RegionState {
  lastRunAtMillis: number;
  outputByPairId: Record<string, PairOutput>;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

process.on("unhandledRejection", (reason) => console.error("[region-probe] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[region-probe] uncaughtException:", err));

async function main(): Promise<void> {
  console.log(`[region-probe] start ${new Date().toISOString()}`);
  const now = new Date();
  const prevState = await readJson<RegionState>(STATE_PATH, { lastRunAtMillis: 0, outputByPairId: {} });

  const touched = await fetchTouchedDocs(prevState.lastRunAtMillis);
  console.log(`[region-probe] ${touched.length} documents touched since last run`);

  const result = buildOutput(
    touched,
    prevState.outputByPairId,
    now,
    WINDOW_DAYS,
    SAMPLE_FLOOR,
    RISK_THRESHOLD,
    prevState.lastRunAtMillis
  );

  // Prune while reading. Each write does NOT touch lastUpdated (see
  // regionFirestore.ts), so it can never make a doc spuriously reappear as
  // "touched" on the next cursor query.
  for (const { docId, prunedCounts } of result.prunedWrites) {
    await writePrunedCounts(docId, prunedCounts);
  }

  const output = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    riskyPairs: result.riskyPairs,
  };

  const newState: RegionState = { lastRunAtMillis: result.maxLastUpdatedMillis, outputByPairId: result.outputByPairId };
  await writeFile(STATE_PATH, JSON.stringify(newState));
  await writeFile(OUTPUT_PATH, JSON.stringify(output));
  console.log(`[region-probe] published ${result.riskyPairs.length} risky pairs, cursor advanced to ${new Date(result.maxLastUpdatedMillis).toISOString()}`);
}

main().catch((e) => {
  console.error("region-probe run failed:", e);
  process.exit(1);
});
