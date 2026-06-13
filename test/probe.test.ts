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
});
