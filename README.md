# pixelplay-health

A free, scheduled GitHub Action that probes the public [iptv-org](https://github.com/iptv-org/iptv) catalog and publishes a self-healing `dead.json` known-dead channel list to GitHub Pages. Any downstream consumer can read it to deprioritize or hide globally-dead channels.

- **Only globally-fatal signals list a channel** (DNS/refused/TLS/404/410/5xx + HLS first-segment-404). 403/451/429/timeouts are inconclusive and never listed — this sidesteps single-IP geo-blindness.
- **Self-healing:** regenerated each run, keyed by iptv-org channel id, streak `K=2` with instant reset on any alive run and on catalog re-entry. The list is a regenerated snapshot, never an append-only blacklist.
- **Observability + tripwire:** `status.json` carries the alive/dead/inconclusive rates; if `inconclusiveRate >= 0.50` the run keeps the last-good `dead.json` (the probe vantage is degraded).

## Artifacts (served by GitHub Pages)

- **`dead.json`** — `{ "schemaVersion": 1, "generatedAt": "<ISO8601>", "deadProviderIDs": ["<id>", …] }`. The ids are **raw iptv-org channel ids** (e.g. `cnn.us`) — the same ids iptv-org uses in `streams.json`/`channels.json`. A consumer matches them against its own catalog.
- **`status.json`** — per-run metrics: `{ generatedAt, sampled, aliveRate, deadRate, inconclusiveRate, segmentFalseAliveRate, lowConfidence }`.

## Setup (one-time, manual)

The repo must be **public** (free unlimited Actions minutes + Pages). Create the orphan data branch and enable Pages on it:

```bash
git checkout --orphan data && git rm -rf . && git commit --allow-empty -m init && git push origin data
git checkout main
```

Then in repo Settings → Pages: **source = branch `data`, folder `/ (root)`**. The probe force-pushes `dead.json`/`status.json` to the `data` branch root each run, served at `https://<user>.github.io/pixelplay-health/dead.json`.

## Tuning

`workflow_dispatch` accepts two optional inputs: `concurrency` (`PROBE_CONCURRENCY`, default 40) and `timeout` (`PROBE_TIMEOUT_MS` ms, default 10000). The daily schedule runs at 03:00 UTC.

## Consumer guidance (not part of this repo)

A consumer should treat the list as advisory and **fail-open**: ignore `dead.json` entirely if `generatedAt` is older than a TTL (e.g. 7 days) so a broken pipeline can never silently bury channels. Matching the raw ids against the consumer's own catalog is the consumer's responsibility.

Design notes: `docs/2026-06-13-channel-health-probe-pipeline-design.md`.
