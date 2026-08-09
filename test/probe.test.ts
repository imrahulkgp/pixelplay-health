import { describe, it, expect } from "vitest";
import { probeStream, type FetchFn } from "../src/probe";

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000
media.m3u8`;
const MEDIA = `#EXTM3U
#EXTINF:6.0,
seg0.ts`;

// Build a FetchFn from a url->response table. Missing urls throw ENOTFOUND.
function mockFetch(table: Record<string, { status: number; body?: string }>): FetchFn {
  return async (url: string) => {
    const r = table[url];
    if (!r) {
      const e: any = new Error("dns"); e.cause = { code: "ENOTFOUND" }; throw e;
    }
    return {
      status: r.status,
      url,
      text: async () => r.body ?? "",
    };
  };
}

describe("probeStream", () => {
  it("alive manifest + alive segment -> ALIVE", async () => {
    const fetchFn = mockFetch({
      "https://h/master.m3u8": { status: 200, body: MASTER },
      "https://h/media.m3u8": { status: 200, body: MEDIA },
      "https://h/seg0.ts": { status: 200 },
    });
    const r = await probeStream({ channel: "x", url: "https://h/master.m3u8" }, fetchFn);
    expect(r.verdict).toBe("ALIVE");
  });

  it("alive manifest + 404 segment -> DEAD_SIGNAL (orphaned media) + false-alive flagged", async () => {
    const fetchFn = mockFetch({
      "https://h/master.m3u8": { status: 200, body: MASTER },
      "https://h/media.m3u8": { status: 200, body: MEDIA },
      "https://h/seg0.ts": { status: 404 },
    });
    const r = await probeStream({ channel: "x", url: "https://h/master.m3u8" }, fetchFn);
    expect(r.verdict).toBe("DEAD_SIGNAL");
    expect(r.segment).toBe("dead");
  });

  it("alive manifest + 403 segment -> ALIVE (geo, infra up)", async () => {
    const fetchFn = mockFetch({
      "https://h/master.m3u8": { status: 200, body: MASTER },
      "https://h/media.m3u8": { status: 200, body: MEDIA },
      "https://h/seg0.ts": { status: 403 },
    });
    const r = await probeStream({ channel: "x", url: "https://h/master.m3u8" }, fetchFn);
    expect(r.verdict).toBe("ALIVE");
    expect(r.segment).toBe("na");
  });

  it("manifest 404 -> DEAD_SIGNAL", async () => {
    const fetchFn = mockFetch({ "https://h/m.m3u8": { status: 404 } });
    const r = await probeStream({ channel: "x", url: "https://h/m.m3u8" }, fetchFn);
    expect(r.verdict).toBe("DEAD_SIGNAL");
  });

  it("manifest 403 -> INCONCLUSIVE", async () => {
    const fetchFn = mockFetch({ "https://h/m.m3u8": { status: 403 } });
    const r = await probeStream({ channel: "x", url: "https://h/m.m3u8" }, fetchFn);
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("DNS failure -> DEAD_SIGNAL", async () => {
    const fetchFn = mockFetch({});
    const r = await probeStream({ channel: "x", url: "https://missing/m.m3u8" }, fetchFn);
    expect(r.verdict).toBe("DEAD_SIGNAL");
  });

  it("media-playlist URL (no master) hops straight to the segment -> ALIVE", async () => {
    const fetchFn = mockFetch({
      "https://h/media.m3u8": { status: 200, body: MEDIA },
      "https://h/seg0.ts": { status: 200 },
    });
    const r = await probeStream({ channel: "x", url: "https://h/media.m3u8" }, fetchFn);
    expect(r.verdict).toBe("ALIVE");
    expect(r.segment).toBe("ok");
  });

  it("variant playlist body read aborts mid-stream -> segment 'na' (fail-safe), not a thrown rejection", async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url === "https://h/master.m3u8") return { status: 200, url, text: async () => MASTER };
      if (url === "https://h/media.m3u8") {
        return { status: 200, url, text: async () => { throw new DOMException("aborted", "TimeoutError"); } };
      }
      throw new Error(`unexpected url: ${url}`);
    };
    const r = await probeStream({ channel: "x", url: "https://h/master.m3u8" }, fetchFn);
    expect(r.verdict).toBe("ALIVE");
    expect(r.segment).toBe("na");
  });
});

describe("soft 404s (2xx carrying an error string)", () => {
  const URL_M3U8 = "https://cdn09jtedge.indihometv.com/joss/133/crimeinvestigation/index.m3u8";

  it("marks the real-world case dead instead of inconclusive", async () => {
    // Crime + Investigation Asia, verbatim: 200 OK, mpegurl content-type,
    // body "No route". Before this it returned INCONCLUSIVE, so the channel
    // never reached deadProviderIDs and the app kept offering it to users who
    // then blamed geo-blocking.
    const fetchFn = mockFetch({ [URL_M3U8]: { status: 200, body: "No route" } });
    const r = await probeStream({ url: URL_M3U8 } as any, fetchFn);
    expect(r.verdict).toBe("DEAD_SIGNAL");
  });

  it("closes the false-ALIVE on non-.m3u8 URLs", async () => {
    // The worse half: any other extension reported ALIVE outright.
    const url = "https://cdn.example/live/123.ts";
    const fetchFn = mockFetch({ [url]: { status: 200, body: "No route" } });
    const r = await probeStream({ url } as any, fetchFn);
    expect(r.verdict).toBe("DEAD_SIGNAL");
  });

  it("still reports a healthy stream alive", async () => {
    const base = "https://cdn.example/live";
    const fetchFn = mockFetch({
      [`${base}/index.m3u8`]: { status: 200, body: MASTER },
      [`${base}/media.m3u8`]: { status: 200, body: MEDIA },
      [`${base}/seg0.ts`]: { status: 200 },
    });
    const r = await probeStream({ url: `${base}/index.m3u8` } as any, fetchFn);
    expect(r.verdict).toBe("ALIVE");
  });

  it("an ISP block page stays inconclusive, not dead", async () => {
    // One hostile network must never be able to condemn the catalogue.
    const fetchFn = mockFetch({
      [URL_M3U8]: { status: 200, body: "<html><body>Blocked by your provider</body></html>" },
    });
    const r = await probeStream({ url: URL_M3U8 } as any, fetchFn);
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("a soft error on the variant hop is dead too", async () => {
    const base = "https://cdn.example/live";
    const fetchFn = mockFetch({
      [`${base}/index.m3u8`]: { status: 200, body: MASTER },
      [`${base}/media.m3u8`]: { status: 200, body: "No route" },
    });
    const r = await probeStream({ url: `${base}/index.m3u8` } as any, fetchFn);
    expect(r.verdict).toBe("DEAD_SIGNAL");
  });
});
