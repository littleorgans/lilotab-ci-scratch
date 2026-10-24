// Tab count badge text: listed tabs from live facts, so private and non normal windows never count (C-SET-27).

import { listedTabs } from './snapshot/index.ts';
import type { LiveFacts } from './types.ts';

const BADGE_MAX = 999; // above it the badge shows "999+" (C-SET-27)

export function badgeText(live: LiveFacts): string {
  const n = listedTabs(live);
  return n > BADGE_MAX ? `${String(BADGE_MAX)}+` : String(n);
}
