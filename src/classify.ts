import type { Verdict, SegmentVerdict } from "./types";

/** Manifest-level status classification. 2xx defers to body+segment. */
export function classifyStatus(status: number): Verdict | "CHECK_BODY" {
  if (status === 404 || status === 410 || status >= 500) return "DEAD_SIGNAL";
  if (status === 403 || status === 451 || status === 456 || status === 429) return "INCONCLUSIVE";
  if (status >= 200 && status < 300) return "CHECK_BODY";
  return "INCONCLUSIVE";
}

/** Network-error classification. Only DNS/refused/TLS are globally fatal. */
export function classifyError(code: string | undefined, name: string | undefined): Verdict {
  if (name === "TimeoutError" || name === "AbortError") return "INCONCLUSIVE";
  if (code === "ENOTFOUND" || code === "ECONNREFUSED") return "DEAD_SIGNAL";
  if (code && /CERT|SSL|_TLS|DEPTH|VERIFY|ALERT/i.test(code)) return "DEAD_SIGNAL";
  return "INCONCLUSIVE"; // EAI_AGAIN, ECONNRESET, ETIMEDOUT, unknown
}

/**
 * Longest body still treated as a server's own error string. A CDN answers a
 * dead route in a handful of bytes; an ISP block page or captive portal is a
 * whole HTML document. The size difference is what keeps this from turning one
 * hostile network into a catalogue-wide false-dead.
 */
export const SOFT_ERROR_MAX_LENGTH = 200;

/**
 * A 2xx whose body is a short, readable, non-media string: the server dressing
 * an error as success.
 *
 * Crime + Investigation Asia answers `200 OK`,
 * `Content-Type: application/vnd.apple.mpegurl`, and the eight bytes
 * `No route`. Judging by status alone made that channel INCONCLUSIVE on a
 * `.m3u8` URL and outright ALIVE on any other extension, so it never reached
 * the dead list and the app kept offering it.
 *
 * Deliberately narrow, because a false-dead is the expensive mistake here:
 *
 * - **Anything starting with `<` is excluded.** Captive portals and ISP block
 *   pages are HTML, and those say something about the prober's network rather
 *   than the channel. DASH manifests are XML and are real media.
 * - **Long bodies are excluded**, for the same reason.
 * - **Non-ASCII or binary is excluded** — that is probably media we don't
 *   recognise.
 */
export function looksLikeSoftError(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;                       // nothing to judge
  if (trimmed.length > SOFT_ERROR_MAX_LENGTH) return false;
  if (trimmed.startsWith("<")) return false;        // block page, or a DASH manifest
  if (/#EXTM3U|#EXT-X-/.test(trimmed)) return false; // a (short) playlist is media
  return /^[\x09\x0A\x0D\x20-\x7E]*$/.test(trimmed); // printable ASCII only
}

/** 2xx body classification, after the optional segment hop. */
export function classifyBody(
  isM3U8Url: boolean,
  hasExtM3U: boolean,
  segment: SegmentVerdict | undefined,
  softError = false,
): Verdict {
  if (softError) return "DEAD_SIGNAL";
  if (!hasExtM3U) return isM3U8Url ? "INCONCLUSIVE" : "ALIVE";
  return segment === "dead" ? "DEAD_SIGNAL" : "ALIVE";
}

/** alive > inconclusive > dead. Empty (no probeable URL) fails safe to INCONCLUSIVE — never a false-dead. */
export function combine(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return "INCONCLUSIVE";
  if (verdicts.some((v) => v === "ALIVE")) return "ALIVE";
  if (verdicts.some((v) => v === "INCONCLUSIVE")) return "INCONCLUSIVE";
  return "DEAD_SIGNAL";
}
