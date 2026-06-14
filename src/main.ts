import { readFile, writeFile } from "node:fs/promises";
import { fetchCatalog } from "./catalog";
import { runProbe } from "./run";
import type { StateMap } from "./types";
import type { FetchFn } from "./probe";

// Artifacts live at the ROOT of the orphan `data` branch: GitHub Pages serves a branch from
// its root, so these resolve to https://<user>.github.io/pixelplay-health/dead.json.
const STATE_PATH = "state.json";
const DEAD_PATH = "dead.json";
const STATUS_PATH = "status.json";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 10_000; // env-tunable; cloud vantage may need >10s

const realFetch: FetchFn = async (url, init) => {
  const resp = await fetch(url, {
    headers: init?.headers,
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: resp.status, url: resp.url, text: () => resp.text() };
};

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; }
}

async function main(): Promise<void> {
  console.log(`[probe] start ${new Date().toISOString()}`);
  const { streams, blocked } = await fetchCatalog(realFetch);
  console.log(`[probe] catalog: ${streams.length} streams, ${blocked.size} blocked`);
  const prevState = await readJson<StateMap>(STATE_PATH, {});
  const now = new Date();
  const r = await runProbe(streams, blocked, prevState, realFetch, now);
  console.log(`[probe] runProbe done ${new Date().toISOString()}`);

  // status.json always publishes (observability). On a low-confidence run we keep BOTH the
  // last-good dead.json AND the last-good state.json — persisting a degraded-vantage streak map
  // would let a poisoned streak list channels on the next good run, defeating the tripwire.
  await writeFile(STATUS_PATH, JSON.stringify(r.metrics, null, 2));
  if (r.publishDead) {
    await writeFile(STATE_PATH, JSON.stringify(r.state));
    await writeFile(DEAD_PATH, JSON.stringify(r.dead));
    console.log(`dead.json: ${r.dead.deadProviderIDs.length} dead | inconclusive ${(r.metrics.inconclusiveRate * 100).toFixed(1)}%`);
  } else {
    console.log(`LOW CONFIDENCE (inconclusive ${(r.metrics.inconclusiveRate * 100).toFixed(1)}%) — kept last-good dead.json + state.json`);
  }
}

main().catch((e) => { console.error("probe run failed:", e); process.exit(1); });
