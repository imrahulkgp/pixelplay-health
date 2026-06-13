# Channel Health-Probe Pipeline — Design

**Date:** 2026-06-13
**Status:** Built, reviewed, and live-validated (see "Live validation" below).

## Context

`pixelplay-health` is a free, independent health probe for the public [iptv-org](https://github.com/iptv-org/iptv) catalog. iptv-org **removed the `status` field from `streams.json`** (iptv-org Discussion #402) because they could no longer keep stream health updated — only the sparse `label` field remains. So genuinely-dead channels (DNS gone, 404, orphaned media) sit in the catalog until a community PR fixes them.

This pipeline probes the catalog on a schedule and publishes a self-healing **"known-dead" list** (`dead.json`) that any downstream consumer can read to deprioritize or hide dead channels. Built on **free GitHub Actions (cron) + GitHub Pages** — no servers, no per-user telemetry, no recurring cost.

## Validation (de-risk spike, 2026-06-13)

Before committing to the build, a throwaway probe of a **500-channel random sample from a datacenter IP** measured:

| Metric | Result | Implication |
|---|---|---|
| Hard-dead (404/DNS/refused/TLS/5xx) | **14.4%** | meaningful, listable dead set (~1 in 7 channels) — value is real, not marginal |
| Inconclusive (geo/timeout/429) | 27.2%, **mostly timeouts**; `403` only ~7%, `429` ~0.4% | the datacenter vantage is **not WAF-blocked into uselessness** — the feared failure mode did not materialize |
| Manifest-200-but-segment-dead | **3.3%** of manifest-alive | manifest-only is *largely* sufficient; the segment hop is a cheap bonus, not a necessity |
| Wall-clock | 500 channels w/ segment hops in **88 s** @ concurrency 40 | ~10k channels ≈ ~30 min — comfortably within the 6h Action limit |

These numbers inform the parameters below. **Caveat:** one datacenter IP at one moment; GitHub's specific ranges could differ slightly, but a cloud IP is a good proxy and the low `403` rate is reassuring.

## Goal

Continuously identify catalog channels that are **globally dead** (not merely geo-blocked or slow) and publish a **self-healing, regenerated** dead-list artifact — without ever permanently burying a channel that has come back or whose URL iptv-org has since updated.

## Scope

**This repo:** the probe pipeline — a scheduled GitHub Action that probes the catalog and publishes `dead.json` (plus internal state + metrics).

**Out of scope (consumer's responsibility):** downloading the list, applying a fail-open TTL, matching the raw ids against a consumer's own catalog, and the hide-vs-deprioritize policy. `dead.json` is a plain artifact a consumer reads.

**Also out of scope:** geo/region-aware liveness (a single-region probe can't see it); crowd telemetry; unlinked streams (no channel id).

## Architecture & Data Flow

A standalone **public** repo (public ⇒ unlimited Actions minutes + free Pages):

```
daily cron (GitHub Action, concurrency group: cancel-in-progress)
   │  fetch iptv-org streams.json + blocklist.json (429-backoff on input)
   ▼  apply blocklist → channelID → [stream URLs] map (linked channels only)
probe each channel's URL(s): manifest GET → (if HLS-alive) first-segment hop → classify
   ▼  combine to channel run outcome (alive > inconclusive > dead)
restore prior state → update per-channel failStreak / lastChecked / lastSeen → prune
   ▼
emit dead.json (failStreak ≥ K) + status.json (metrics) ; persist state
   ▼  orphan a fresh single-commit branch → force-push to the data/Pages branch (no git-history bloat)
GitHub Pages serves https://<user>.github.io/pixelplay-health/{dead.json,status.json}
   ▼
a consumer fetches dead.json
```

## Inputs

- iptv-org `streams.json` + `blocklist.json` (the public iptv-org API). `channels.json` is **not** fetched — `streams.json` already carries the raw channel id (used for `deadProviderIDs`), url, `user_agent`, and `referrer`, which is everything the probe needs; channel metadata (name/country/category) is unused here.
- **Apply the copyright blocklist** — never probe blocklisted channels (respects iptv-org's blocklist).
- **Input-fetch resilience:** retry the catalog fetch with backoff on `429`/transient errors; if it persistently fails, **abort the run and keep the last-good artifacts** (never publish a half-built list).
- Build `channelID → [stream URL …]` for **linked channels** (non-null channel id) surviving the blocklist. Probe up to the first N streams per channel (default 3).

## The Probe

Per stream URL, mimic a real player's request:
- **Headers:** the stream's `user_agent` / `referrer` from `streams.json` when present; else a default VLC User-Agent (avoids false-deads on UA-gated streams).
- **Manifest:** GET the HLS manifest (or first bytes for non-HLS), 10s timeout, **one attempt per run**. The cross-run **K=2** streak provides the multi-sample robustness — a one-off `5xx`/timeout never lists, since listing needs 2 consecutive dead runs.
- **Segment hop (HLS only):** if the manifest is 2xx and contains `#EXTM3U`, parse the first variant→first media segment (one master→media level), and `Range: bytes=0-1` GET it. This catches CDN-orphaned masters (200 manifest, dead media). The spike confirmed it's cheap (~3.3% extra deads).
- **Concurrency:** capped (default **40**, env-tunable via `PROBE_CONCURRENCY`). A post-implementation dry-run showed conc 80 self-inflicts mass timeouts from a constrained vantage (see "Post-implementation findings") — 40 is the spike-validated level.

### Per-URL classification — pure function

`classify(outcome) → ALIVE | DEAD_SIGNAL | INCONCLUSIVE`:

- **DEAD_SIGNAL** (globally fatal): DNS failure, connection refused, TLS failure, HTTP **404 / 410 / 5xx**, **or** an alive HLS manifest whose **first segment is hard-dead** (segment 404/410/5xx).
- **INCONCLUSIVE** (must never list): **403 / 451 / 456** (possible geo), **429**, **timeouts**, a `200` response missing `#EXTM3U` *for an `.m3u8` URL* (malformed / soft-offline — not provably dead), or any other ambiguous result.
- **ALIVE**: `2xx` manifest + segment 2xx; **or** an alive manifest whose segment is blocked/inconclusive (manifest infra works → not globally dead — likely geo); **or** a non-HLS `2xx` with non-empty body.

The guardrail: **only globally-fatal signals build toward "dead"; geo / timeout / rate-limit / segment-geo-block never do.** A reachable-manifest-but-geo-blocked-segment is ALIVE (works in-region), while a reachable-manifest-but-404-segment is DEAD_SIGNAL (orphaned). **False-dead is worse than false-alive.**

### The combine rule (a channel's URLs → run outcome)

> **ALIVE** if *any* URL is ALIVE; else **INCONCLUSIVE** if *any* is INCONCLUSIVE; else **DEAD_SIGNAL** (every URL is globally fatal).

So a channel with URLs `[404, 403]` is INCONCLUSIVE (the 403 might play elsewhere) — only `[404, 404]` is DEAD_SIGNAL.

## State, Streak & Resurrection — pure function + durable storage

Per-channel state: `{ failStreak, lastChecked, lastSeen }`, keyed by **iptv-org channel id**.

Each run, per channel:
- run **ALIVE** → `failStreak = 0` *(instant resurrection)*
- run **DEAD_SIGNAL** → `failStreak += 1`
- run **INCONCLUSIVE** → `failStreak` unchanged
- update `lastChecked`; set `lastSeen = now` if the channel is in the fresh catalog.
- **Re-entry reset:** if a channel reappears after an absence (gap in `lastSeen` > 2× cadence), reset `failStreak = 0` (fresh evaluation — avoids stale-streak leaking across an absence or an id-reuse).
- **Prune** channels with `lastSeen` older than 30 days.

A channel is **listed dead iff `failStreak ≥ K`** (default **K = 2**; hard-dead signals are stable, and in-run retries + segment confirmation already filter transients — so 2 consecutive runs is enough while keeping latency low; tunable).

**Resurrection** is automatic via both paths: a same-URL revival or an iptv-org URL swap (we re-pull the catalog every run and key by stable channel id) → next run probes the current URL → ALIVE → streak 0 → dropped. The list is a **regenerated snapshot, never an append-only blacklist.**

**Durable storage (no git-history bloat):** state + artifacts live on a dedicated **orphan data/Pages branch**, written by orphaning a fresh single-commit branch each run and force-pushing it (no accumulating history for a daily-rewritten ~1–2 MB file). The workflow uses a **`concurrency` group with cancel-in-progress** so two runs never write concurrently (guards against a `workflow_dispatch` re-run racing the cron).

## Artifacts

**`dead.json`** (published):
```json
{ "schemaVersion": 1, "generatedAt": "<ISO8601>", "deadProviderIDs": ["<iptv-org channel id>", "…"] }
```

**`status.json`** (published; observability — see tripwire):
```json
{ "generatedAt": "<ISO8601>", "sampled": 0, "aliveRate": 0.0, "deadRate": 0.0,
  "inconclusiveRate": 0.0, "segmentFalseAliveRate": 0.0, "lowConfidence": false }
```

**state** (on the data branch; internal): the per-channel map above.

## Artifact id format

`dead.json` keys (`deadProviderIDs`) are **raw iptv-org channel ids** (e.g. `cnn.us`) — the same ids iptv-org uses in `streams.json`/`channels.json`. The field name `deadProviderIDs` makes the raw-id format unambiguous. A consumer matches these ids against its own catalog; that matching is the consumer's responsibility and out of scope here.

## Observability & confidence tripwire

The run computes the `status.json` rates. **If `inconclusiveRate ≥ 0.50`** (the spike baseline is ~0.27, so this trips only on genuine vantage degradation — e.g. GitHub IPs newly WAF-blocked), the run sets `lowConfidence: true` and **publishes `status.json` but does NOT overwrite `dead.json`** (keeps the last-good list). This prevents a shadow-banned probe from silently emptying the dead list. The rates are the primary signal for the go/no-go review.

## Hosting & Freshness

- GitHub Pages of the public repo; consumers fetch `https://<user>.github.io/pixelplay-health/dead.json`.
- `generatedAt` lets a consumer age out a stale list (a fail-open TTL — e.g. 7 days → ignore, deprioritize nothing).
- **Cadence: daily** (`cron: "0 3 * * *"`). The run is cheap (~30 min); tunable.

## Privacy & Compliance

- **Zero user data** — no telemetry, no accounts.
- Probes only the **public, blocklist-filtered iptv-org catalog**.
- **Minimal-byte** probes (manifest + a 2-byte segment range, not full streams), daily, concurrency-capped. The "GitHub runner IPs probe third-party endpoints" note is documented; the spike confirmed low active blocking (`403` ~7%).

## Error Handling

- Catalog fetch fails (after 429-backoff/retries) → abort, publish nothing, keep last-good.
- Per-channel probe error → INCONCLUSIVE (never a false-dead, never a crash).
- `inconclusiveRate ≥ 0.50` → low-confidence, keep last-good `dead.json` (tripwire above).
- A no-op probe (produced no fresh `status.json`) **fails the publish** rather than republishing stale data.

## Testing (TDD)

Pure functions carry the correctness risk:

- **`classify`:** `200+#EXTM3U+segment2xx` → ALIVE; `200+#EXTM3U+segment404` → **DEAD_SIGNAL**; `200+#EXTM3U+segment403` → ALIVE (geo, not dead); `200` non-m3u8 → ALIVE; `404`/`410` → DEAD; `5xx` → DEAD; DNS/refused/TLS → DEAD; `403`/`451`/`456`/`429`/timeout → INCONCLUSIVE; `.m3u8` `200` without `#EXTM3U` → INCONCLUSIVE.
- **`combine`:** any ALIVE → ALIVE; else any INCONCLUSIVE → INCONCLUSIVE; else DEAD_SIGNAL. Cover `[DEAD,INCONCLUSIVE]→INCONCLUSIVE` and `[DEAD,ALIVE]→ALIVE`.
- **`updateStreak` + `isDead(K)`:** ALIVE resets; DEAD increments; INCONCLUSIVE holds; `≥K` lists; reset drops; **re-entry-after-absence resets `failStreak`**.
- **Pruning:** `lastSeen > 30d` removed; in-catalog keeps fresh.
- **id format:** emitted `deadProviderIDs` are raw iptv-org ids (a fixture pins `cnn.us`).
- **Tripwire:** `inconclusiveRate ≥ 0.50` ⇒ `lowConfidence:true` and `dead.json` not overwritten.
- **Schema:** `dead.json` / `status.json` validate.
- **Integration smoke (mocked HTTP, deterministic):** alive; manifest-200-but-segment-404 → listed after K runs; inconclusive; resurrection (dead then alive → dropped); URL-swap-keeps-id → re-probed alive.

**Tech stack:** Node + TypeScript + vitest (run via `tsx`, no build step).

## Parameters (defaults; tunable; informed by the spike)

| Parameter | Default | Rationale |
|---|---|---|
| `K` (consecutive DEAD_SIGNAL runs to list) | 2 | hard-dead is stable; retries + segment confirm filter transients |
| Cadence | daily (`0 3 * * *`) | run is cheap (~30 min) |
| Per-URL timeout | 10s (env `PROBE_TIMEOUT_MS`) | |
| Attempts / URL / run | 1 | cross-run K=2 absorbs transients |
| Streams probed / channel | 3 | |
| Concurrency | **40** (env `PROBE_CONCURRENCY`) | conc 80 self-inflicts timeouts (dry-run: 64→501 timeouts on the same 500 sample); 40 = spike-validated (~88 s/500, ~25 min/10k) |
| Segment hop | on | +~3.3% deads, cheap |
| Inconclusive tripwire | ≥ 0.50 → low-confidence, keep last-good | spike baseline ~0.27 |
| State prune | 30 days `lastSeen` | |

## Audit & spike — folded-in changes (rev 2)

An independent adversarial audit (verdict: SOUND-WITH-GAPS) + the de-risk spike produced these changes from rev 1:

- **[BLOCKER fixed]** Explicit **raw-id format** — `dead.json` emits raw `deadProviderIDs`; consumers match them against their own catalog (an earlier draft left the id form ambiguous, risking a consumer matching nothing).
- **[IMPORTANT]** Added the **segment hop** (catches CDN-orphaned `200`-manifest/dead-media); classified so a geo-blocked segment stays ALIVE while a 404 segment is DEAD.
- **[IMPORTANT]** Added **observability + a `inconclusiveRate ≥ 0.50` tripwire** that keeps the last-good list if the vantage point is degraded — so an empty `dead.json` can't silently mean "shadow-banned."
- **[IMPORTANT]** **Durable, non-git-history state** (orphan data branch, single force-pushed commit) + a **`concurrency` group** — fixes daily-commit repo bloat and re-run races.
- **Spike validated:** ~14% hard-dead, vantage not WAF-blocked (403 ~7%), 3.3% manifest-false-alive, ~30 min/10k. Lowered `K` to 2 and kept daily cadence.

## Post-implementation findings (rev 3)

Built (Node+TS+vitest, 39 tests), final whole-repo review = READY-WITH-NITS, then validated with a live dry-run against the real catalog:

- **[FIX — concurrency self-DoS]** A draft had bumped concurrency from the spike's validated 40 to 80 for speed. A full-catalog dry-run (8,657 channels) at conc 80 measured **93.6% inconclusive** (vs the spike's 27%), 33 min wall at 2% CPU — nearly everything timing out. An A/B on the same 500-channel sample isolated the cause: timeouts **64 (conc 20) → 501 (conc 80)** while `403` *fell* (46→16). So the high inconclusive was self-inflicted egress saturation, **not WAF**. Default lowered to **40** (env `PROBE_CONCURRENCY`). The tripwire worked exactly as designed — it refused to publish the garbage run.
- **[FIX — single rolling commit]** The workflow orphans a fresh branch each run (after reading yesterday's `state.json` for streak continuity) and force-pushes it, so the `data` branch stays at exactly one commit.
- **[DOC]** `channels.json` removed from the input list — `streams.json` already carries everything the probe needs.

## Live validation on GitHub (2026-06-13)

Ran real `workflow_dispatch` jobs (conc 40):

- **Clean run:** ~66% alive / **~15% dead** / **~19% inconclusive**, `lowConfidence:false` → published (matches the spike's ~14% dead).
- **First real `dead.json`: 1,191 channels, raw ids** (`13E.cl`, `2GB.au`, …). K=2 + resurrection visibly working (baseline 1,299 dead-once → 1,191 dead-twice as some recovered).
- **False-positive spot-check: 12/12 true-dead** (404/DNS/expired-TLS/orphaned-media), **zero false-deads.** The segment hop correctly catches "200-manifest/dead-segment" (e.g. a manifest 200 with a first-segment 404).

**Operational findings folded into the workflow/code:**
- **Concurrency:** default **40** (env `PROBE_CONCURRENCY`); conc 80 self-DoSes via timeouts. `PROBE_TIMEOUT_MS` also env-tunable (default 10s).
- **Run-to-run variance is real:** ~2 of 4 runs hit transient ≥50% inconclusive; the tripwire correctly suppressed them (kept last-good). The tripwire is load-bearing, not theoretical.
- **No-op guard:** one run's probe silently produced no fresh `status.json` yet exited 0; the workflow now clears `status.json` pre-probe and **fails the publish if it wasn't regenerated** — never republish stale data. `status.json` is also uploaded as a workflow artifact + written to the job summary (GitHub truncates long-step stdout).
- **Single rolling commit** (orphan-per-run) verified on the live data branch.
