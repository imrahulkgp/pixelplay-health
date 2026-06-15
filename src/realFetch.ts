import { withTimeout } from "./timeout";
import type { FetchFn } from "./probe";

export type RawFetch = (
  url: string,
  init?: { headers?: Record<string, string>; redirect?: "follow"; signal?: AbortSignal },
) => Promise<{ status: number; url: string; text(): Promise<string> }>;

/**
 * withTimeout must wrap BOTH phases of a fetch independently: the initial
 * request (resolving to a Response with status/url) and resp.text() (draining
 * the body). Either can hang forever on a stalled connection -- and once the
 * first phase resolves, its withTimeout's ref'd setTimeout is cleared, so
 * `ac.abort()` would never fire for a hung resp.text() without its own timer.
 */
export function createRealFetch(timeoutMs: number, rawFetch: RawFetch = fetch): FetchFn {
  return async (url, init) => {
    const ac = new AbortController();
    const resp = await withTimeout(
      () => rawFetch(url, { headers: init?.headers, redirect: "follow", signal: ac.signal }),
      timeoutMs,
      () => ac.abort(),
    );
    return {
      status: resp.status,
      url: resp.url,
      text: () => withTimeout(() => resp.text(), timeoutMs, () => ac.abort()),
    };
  };
}
