export type Verdict = "ALIVE" | "DEAD_SIGNAL" | "INCONCLUSIVE";
export type SegmentVerdict = "ok" | "dead" | "na";

export interface Stream {
  channel: string | null;
  url: string;
  user_agent?: string | null;
  referrer?: string | null;
}

export interface ChannelState {
  failStreak: number;
  lastChecked: string; // ISO 8601
  lastSeen: string; // ISO 8601
}
export type StateMap = Record<string, ChannelState>;
