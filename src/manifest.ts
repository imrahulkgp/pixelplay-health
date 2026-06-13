export interface FirstURI {
  type: "variant" | "segment";
  uri: string;
}

function uriAfter(lines: string[], tag: string): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith(tag)) {
      for (let j = i + 1; j < lines.length; j++) {
        const v = lines[j]!.trim();
        if (v && !v.startsWith("#")) return v;
      }
    }
  }
  return null;
}

/** First variant (master) preferred over first segment (media). */
export function firstURI(text: string): FirstURI | null {
  const lines = text.split(/\r?\n/);
  const variant = uriAfter(lines, "#EXT-X-STREAM-INF");
  if (variant) return { type: "variant", uri: variant };
  const segment = uriAfter(lines, "#EXTINF");
  if (segment) return { type: "segment", uri: segment };
  return null;
}
