import type { StateMap } from "./types";
import { isDead } from "./streak";

export interface DeadJson {
  schemaVersion: number;
  generatedAt: string;
  deadProviderIDs: string[];
}

/**
 * Emits RAW iptv-org provider ids (e.g. "cnn.us"), sorted. Consumers match these
 * against their own catalog (consumer-side matching is out of scope for this repo).
 */
export function buildDeadJson(state: StateMap, now: Date, k?: number): DeadJson {
  const deadProviderIDs = Object.entries(state)
    .filter(([, s]) => isDead(s, k))
    .map(([id]) => id)
    .sort();
  return { schemaVersion: 1, generatedAt: now.toISOString(), deadProviderIDs };
}
