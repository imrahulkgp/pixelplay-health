import { describe, it, expect } from "vitest";
import { firstURI } from "../src/manifest";

const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=400000
480p/index.m3u8`;

const media = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
segment0.ts
#EXTINF:6.0,
segment1.ts`;

describe("firstURI", () => {
  it("returns the first variant for a master playlist", () => {
    expect(firstURI(master)).toEqual({ type: "variant", uri: "720p/index.m3u8" });
  });
  it("returns the first segment for a media playlist", () => {
    expect(firstURI(media)).toEqual({ type: "segment", uri: "segment0.ts" });
  });
  it("returns null when there is nothing to follow", () => {
    expect(firstURI("#EXTM3U\n#EXT-X-ENDLIST")).toBeNull();
  });
});
