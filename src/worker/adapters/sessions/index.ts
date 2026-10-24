// Recently closed tabs through the optional sessions permission: read at the press, reopened on commit (C-SRCH-27,
// C-SRCH-28, C-PERM-05). Only this device's tabs; never another device's sessions.

import type { ClosedTab } from '../../../core/index.ts';
import { fault } from '../../diagnostics.ts';
import { iconKeyOf } from '../icons/index.ts';
import { isPrivate } from '../tabs/index.ts';

const CLOSED_MAX = 25; // C-SRCH-27; Chrome's sessions.MAX_SESSION_RESULTS

// chrome.sessions is undefined in a worker started without the permission; after removal in a running worker each
// call throws, so it reads and restores nothing (C-SET-29).
const api = (): typeof chrome.sessions | undefined => (chrome as Partial<typeof chrome>).sessions;

// Most recent first; closed windows are skipped and private tabs dropped (C-SRCH-27, C-PRIV-08).
export async function recentlyClosed(): Promise<ClosedTab[]> {
  const sessions = api();
  if (!sessions) return [];
  const entries = await sessions.getRecentlyClosed({ maxResults: CLOSED_MAX });
  return entries.flatMap(({ tab }) =>
    tab?.sessionId !== undefined && !isPrivate(tab)
      ? [{ sessionId: tab.sessionId, title: tab.title ?? '', url: tab.url ?? '', iconKey: iconKeyOf(tab) }]
      : [],
  );
}

// Chrome reopens the tab where it restores it (C-SRCH-28); a session gone since the press reopens nothing.
export function restore(sessionId: string): void {
  void api()?.restore(sessionId).catch(fault);
}
