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

/** 2xx body classification, after the optional segment hop. */
export function classifyBody(
  isM3U8Url: boolean,
  hasExtM3U: boolean,
  segment: SegmentVerdict | undefined,
): Verdict {
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
