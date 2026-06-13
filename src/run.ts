import type { Stream, StateMap, Verdict } from "./types";
import type { FetchFn } from "./probe";
import { probeChannel } from "./probe";
import { groupByChannel } from "./catalog";
import { updateChannel, prune, CADENCE_MS } from "./streak";
import { buildDeadJson, type DeadJson } from "./artifacts";
import { computeMetrics, type Metrics } from "./metrics";

// Default 40, the de-risk-spike-validated level (~27% inconclusive). A dry-run measured that
// conc 80 self-inflicts mass timeouts from a constrained vantage (timeouts 64→501 on the same
// 500-channel sample, inconclusive 18%→81%), which trips the tripwire and publishes nothing.
// Env-tunable so ops can adjust per the runner's egress without a code change.
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY) || 40;

async function pool<T, R>(items: T[], worker: (t: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  async function run(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

export interface RunResult {
  state: StateMap;
  dead: DeadJson;
  metrics: Metrics;
  publishDead: boolean; // false when low-confidence -> keep last-good
}

export async function runProbe(
  streams: Stream[],
  blocked: Set<string>,
  prevState: StateMap,
  fetchFn: FetchFn,
  now: Date = new Date(),
): Promise<RunResult> {
  const byChannel = groupByChannel(streams, blocked);
  const ids = Object.keys(byChannel);

  const probed = await pool(
    ids,
    async (id) => ({ id, ...(await probeChannel(byChannel[id]!, fetchFn)) }),
    CONCURRENCY,
  );

  const nextState: StateMap = { ...prevState };
  const outcomes: Verdict[] = [];
  let segmentChecked = 0;
  let segmentFalseAlive = 0;

  for (const { id, verdict, segment } of probed) {
    nextState[id] = updateChannel(prevState[id], verdict, now, CADENCE_MS);
    outcomes.push(verdict);
    // segmentFalseAlive counts manifests that were 2xx/ALIVE but whose first segment was
    // hard-dead — i.e. a "false alive" the manifest-only check would have missed.
    // Drives status.segmentFalseAliveRate. (Geo-blocked segments are "na", not counted.)
    if (segment === "ok" || segment === "dead") {
      segmentChecked++;
      if (segment === "dead") segmentFalseAlive++;
    }
  }

  const pruned = prune(nextState, now);
  const metrics = computeMetrics(outcomes, segmentChecked, segmentFalseAlive, now);
  const dead = buildDeadJson(pruned, now);
  return { state: pruned, dead, metrics, publishDead: !metrics.lowConfidence };
}
