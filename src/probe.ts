import type { Stream, Verdict, SegmentVerdict } from "./types";
import { classifyStatus, classifyError, classifyBody, combine } from "./classify";
import { firstURI } from "./manifest";

export const VLC_UA = "VLC/3.0.18 LibVLC/3.0.18";

export interface FetchResponse {
  status: number;
  url: string;
  text(): Promise<string>;
}
export type FetchFn = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponse>;

export interface StreamResult {
  verdict: Verdict;
  segment?: SegmentVerdict; // present when a manifest segment hop ran
}

function headersFor(stream: Stream): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": stream.user_agent || VLC_UA };
  if (stream.referrer) h["Referer"] = stream.referrer;
  return h;
}

function isM3U8(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url);
}

async function classifyResponse(
  resp: FetchResponse,
  isM3U8Url: boolean,
  fetchFn: FetchFn,
  headers: Record<string, string>,
): Promise<StreamResult> {
  const status = classifyStatus(resp.status);
  if (status !== "CHECK_BODY") return { verdict: status };
  let body = "";
  try { body = await resp.text(); } catch { return { verdict: "INCONCLUSIVE" }; }
  const hasExtM3U = /#EXTM3U/.test(body);
  if (!hasExtM3U) return { verdict: classifyBody(isM3U8Url, false, undefined) };
  const segment = await segmentHop(body, resp.url, fetchFn, headers);
  return { verdict: classifyBody(true, true, segment), segment };
}

/** Returns 'ok' | 'dead' | 'na' (na = blocked/unparseable, not a false-alive). */
export async function segmentHop(
  manifest: string,
  baseUrl: string,
  fetchFn: FetchFn,
  headers: Record<string, string>,
): Promise<SegmentVerdict> {
  const first = firstURI(manifest);
  if (!first) return "na";
  let segUrl = new URL(first.uri, baseUrl).href;
  if (first.type === "variant") {
    let r: FetchResponse;
    try { r = await fetchFn(segUrl, { headers }); } catch { return "na"; }
    if (r.status === 403 || r.status === 451 || r.status === 429) return "na";
    if (r.status < 200 || r.status >= 300) return "dead";
    let seg: ReturnType<typeof firstURI>;
    try { seg = firstURI(await r.text()); } catch { return "na"; }
    if (!seg) return "na";
    segUrl = new URL(seg.uri, r.url).href;
  }
  let r: FetchResponse;
  try { r = await fetchFn(segUrl, { headers: { ...headers, Range: "bytes=0-1" } }); } catch { return "na"; }
  if (r.status === 200 || r.status === 206) return "ok";
  if (r.status === 403 || r.status === 451 || r.status === 429) return "na";
  if (r.status === 404 || r.status === 410 || r.status >= 500) return "dead";
  return "na";
}

export async function probeStream(stream: Stream, fetchFn: FetchFn): Promise<StreamResult> {
  const headers = headersFor(stream);
  let resp: FetchResponse;
  try {
    resp = await fetchFn(stream.url, { headers });
  } catch (e: any) {
    return { verdict: classifyError(e?.cause?.code ?? e?.code, e?.name) };
  }
  return classifyResponse(resp, isM3U8(stream.url), fetchFn, headers);
}

/** Probe up to maxStreams of a channel; combine alive>inconclusive>dead. */
export async function probeChannel(
  streams: Stream[],
  fetchFn: FetchFn,
  maxStreams = 3,
): Promise<{ verdict: Verdict; segment?: SegmentVerdict }> {
  const picked = streams.slice(0, maxStreams);
  const results = await Promise.all(picked.map((s) => probeStream(s, fetchFn)));
  const verdict = combine(results.map((r) => r.verdict));
  const segment = results.find((r) => r.segment === "dead")?.segment
    ?? results.find((r) => r.segment === "ok")?.segment
    ?? results.find((r) => r.segment)?.segment;
  return { verdict, segment };
}
