import { readFile, writeFile } from "node:fs/promises";
import { fetchCatalog } from "./catalog";
import { runProbe } from "./run";
import { withTimeout } from "./timeout";
import type { StateMap } from "./types";
import type { FetchFn } from "./probe";

// Artifacts live at the ROOT of the orphan `data` branch: GitHub Pages serves a branch from
// its root, so these resolve to https://<user>.github.io/pixelplay-health/dead.json.
const STATE_PATH = "state.json";
const DEAD_PATH = "dead.json";
const STATUS_PATH = "status.json";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 10_000; // env-tunable; cloud vantage may need >10s

// withTimeout (not just AbortSignal.timeout) is required: a fetch stuck on DNS
// resolution can hang past AbortSignal.timeout's deadline without ever
// settling, and since that timer is unref'd, the pending fetch holds no ref
// on the event loop -- once every other channel finishes, the process exits
// 0 with this one promise (and pool()'s Promise.all) permanently pending,
// before status.json/dead.json are ever written (e.g. run 27504726572,
// stuck on AlEkhbariya.sa for the entire ~21min run). withTimeout's own
// ref'd setTimeout guarantees this function settles within TIMEOUT_MS
// regardless of the underlying fetch's state.
const realFetch: FetchFn = async (url, init) => {
  const ac = new AbortController();
  const resp = await withTimeout(
    () => fetch(url, { headers: init?.headers, redirect: "follow", signal: ac.signal }),
    TIMEOUT_MS,
    () => ac.abort(),
  );
  return { status: resp.status, url: resp.url, text: () => resp.text() };
};

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; }
}

// Defense in depth: a rejection/exception that escapes main()'s own try/catch
// should still leave a trace in the step log rather than exiting silently.
process.on("unhandledRejection", (reason) => console.error("[probe] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[probe] uncaughtException:", err));

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
