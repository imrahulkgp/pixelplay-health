import type { Stream } from "./types";
import { VLC_UA, type FetchFn } from "./probe";

const BASE = "https://iptv-org.github.io/api";

export type SleepFn = (ms: number) => Promise<void>;
const realSleep: SleepFn = (ms) => new Promise((res) => setTimeout(res, ms));

export async function fetchJson<T>(url: string, fetchFn: FetchFn, sleep: SleepFn = realSleep): Promise<T> {
  // Retry with backoff on 429/5xx/transient (resolves audit: input rate-limit).
  // `sleep` is injectable so tests don't wait on real timers.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetchFn(url, { headers: { "User-Agent": VLC_UA } });
      if (r.status === 429 || r.status >= 500) { await r.text().catch(() => {}); throw new Error(`status ${r.status}`); }
      if (r.status < 200 || r.status >= 300) throw new Error(`status ${r.status}`);
      return JSON.parse(await r.text()) as T;
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error("unreachable");
}

interface BlocklistEntry { channel?: string }

export async function fetchCatalog(fetchFn: FetchFn): Promise<{ streams: Stream[]; blocked: Set<string> }> {
  const [streams, blocklist] = await Promise.all([
    fetchJson<Stream[]>(`${BASE}/streams.json`, fetchFn),
    fetchJson<BlocklistEntry[]>(`${BASE}/blocklist.json`, fetchFn),
  ]);
  const blocked = new Set(blocklist.map((b) => b.channel).filter((c): c is string => !!c));
  return { streams, blocked };
}

export function groupByChannel(streams: Stream[], blocked: Set<string>): Record<string, Stream[]> {
  const out: Record<string, Stream[]> = {};
  for (const s of streams) {
    if (!s.channel || !s.url || blocked.has(s.channel)) continue;
    (out[s.channel] ??= []).push(s);
  }
  return out;
}
