import type { Stream, StateMap, Verdict } from "./types";
import type { FetchFn } from "./probe";
import { probeChannel } from "./probe";
import { groupByChannel } from "./catalog";
import { updateChannel, prune, CADENCE_MS } from "./streak";
import { buildDeadJson, type DeadJson } from "./artifacts";
import { computeMetrics, type Metrics } from "./metrics";
import { pool } from "./pool";

// Default 40, the de-risk-spike-validated level (~27% inconclusive). A dry-run measured that
// conc 80 self-inflicts mass timeouts from a constrained vantage (timeouts 64→501 on the same
// 500-channel sample, inconclusive 18%→81%), which trips the tripwire and publishes nothing.
// Env-tunable so ops can adjust per the runner's egress without a code change.
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY) || 40;

// Soft deadline for the probing pool itself. Observed: at concurrency 40 the pool covers
// ~8600 channels in ~24min, and the GH-hosted runner has twice been killed by a
// "received a shutdown signal" cancellation at ~28-30min -- with nothing written yet.
// 15min caps the pool well inside that budget, leaving headroom for catalog fetch,
// writing status/dead/state.json, and the data-branch publish step. Channels not
// reached this run keep their prevState (graceful degradation); `shuffle` below spreads
// the carried-forward channels across runs so coverage isn't permanently stuck on a
// catalog-order suffix.
const DEADLINE_MS = Number(process.env.PROBE_DEADLINE_MS) || 15 * 60 * 1000;

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface RunResult {
  state: StateMap;
  dead: DeadJson;
  metrics: Metrics;
  publishDead: boolean; // false when low-confidence -> keep last-good
}

export interface RunProbeOptions {
  concurrency?: number;
  deadlineMs?: number;
  clock?: () => number;
}

export async function runProbe(
  streams: Stream[],
  blocked: Set<string>,
  prevState: StateMap,
  fetchFn: FetchFn,
  now: Date = new Date(),
  opts: RunProbeOptions = {},
): Promise<RunResult> {
  const concurrency = opts.concurrency ?? CONCURRENCY;
  const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
  const clock = opts.clock ?? Date.now;

  const byChannel = groupByChannel(streams, blocked);
  const ids = shuffle(Object.keys(byChannel));
  const deadline = clock() + deadlineMs;

  let done = 0;
  const probed = await pool(
    ids,
    async (id) => {
      const result = { id, ...(await probeChannel(byChannel[id]!, fetchFn)) };
      done++;
      if (done % 200 === 0 || done === ids.length) console.log(`[probe] ${done}/${ids.length} channels checked`);
      return result;
    },
    concurrency,
    deadline,
    clock,
  );

  const nextState: StateMap = { ...prevState };
  const outcomes: Verdict[] = [];
  let segmentChecked = 0;
  let segmentFalseAlive = 0;
  let skipped = 0;

  for (const p of probed) {
    if (!p) { skipped++; continue; } // soft deadline hit -- carry forward prevState as-is
    const { id, verdict, segment } = p;
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
  if (skipped > 0) console.log(`[probe] soft deadline reached: ${skipped}/${ids.length} channels not probed this run (state carried forward)`);

  const pruned = prune(nextState, now);
  const metrics = computeMetrics(outcomes, segmentChecked, segmentFalseAlive, now);
  const dead = buildDeadJson(pruned, now);
  return { state: pruned, dead, metrics, publishDead: !metrics.lowConfidence };
}
