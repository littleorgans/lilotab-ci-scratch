// Frozen list for one interaction: rows, quick target, cursor and look (03-components 4.6, 04-state-machine 6).

import {
  SITE_MAX,
  TITLE_MAX,
  URL_MAX,
  fitText,
  type CopyText,
  type ListRow,
  type ListView,
  type Look,
} from '../protocol/index.ts';
import type { Candidate } from '../ranking/index.ts';
import { globalList, windowList, windowOrder, type Recents } from '../recents/index.ts';
import type { Settings } from '../settings/index.ts';
import type { ClosedTab, Cursor, LiveFacts, LiveTab, RowRef, TabId, TabRef, WindowId } from '../types.ts';
import { urlParts } from '../url.ts';

export interface SnapRow {
  tabId: TabId;
  title: string; // full; listView cuts the display copy, ranking reads this one
  url: string;
  pinned: boolean;
  audible: boolean;
  useRank: number | null; // global recency among listed tabs, 0 most recent; null = never activated
  barIndex: number;
  iconKey: string | null;
}

export interface SnapWindow {
  windowId: WindowId;
  current: number; // row of its active tab at the press, apart from row order (T-24, C-WIN-01)
  rows: readonly SnapRow[];
}

export interface Snapshot {
  source: TabRef;
  windows: readonly SnapWindow[]; // [0] is the source window, then window recency (C-WIN-02)
  quick: Cursor | null; // where a quick tap goes; null = nothing to switch to (C-TAP-07)
  initial: Cursor; // list mode: the current tab (C-HOLD-24); else quick (C-HOLD-04), else the current tab (C-HOLD-05)
  stack: readonly Cursor[] | null; // Flip to last tab, All windows: every row by global recency, never used last; held steps walk it
  closed: readonly ClosedTab[]; // most recent first; empty unless Include recently closed tabs is On (C-SRCH-27, C-SET-22)
}

export const lookOf = (s: Settings): Look => ({ theme: s.theme, reduceMotion: s.reduceMotion, textSize: s.textSize });

export const listedTabs = (live: LiveFacts): number => live.windows.reduce((n, w) => n + w.tabs.length, 0);

// Recents must already be reconciled with these live facts (T-03), so every listed tab is known.
// null when the source tab is not in a listed window: a press from a window that is not normal does nothing.
export function buildSnapshot(
  r: Recents,
  live: LiveFacts,
  settings: Settings,
  source: TabRef,
  closed: readonly ClosedTab[],
): Snapshot | null {
  const byId = new Map(live.windows.map((w) => [w.windowId, w.tabs]));
  if (!byId.get(source.windowId)?.some((t) => t.tabId === source.tabId)) return null;

  const listed = globalList(r).filter((t) => byId.has(t.windowId));
  const useRank = new Map(listed.map((t, i) => [t.tabId, i]));
  const used = (tabId: TabId) => r.tabs.get(tabId)?.used ?? 0;

  const windows = windowOrder(r, [...byId.keys()], source.windowId).map((windowId): SnapWindow => {
    const tabs = (byId.get(windowId) ?? []).map((t, barIndex) => ({ t, barIndex }));
    // Recent: current tab, then by use, then never used in tab bar order (C-HOLD-02). Window order: tab bar (C-HOLD-03).
    if (settings.tabOrder === 'recent') {
      const key = ({ t }: { t: LiveTab }) => (t.active ? Infinity : used(t.tabId));
      tabs.sort((a, b) => key(b) - key(a) || a.barIndex - b.barIndex);
    }
    const rows = tabs.map(({ t, barIndex }) => ({
      tabId: t.tabId,
      title: t.title,
      url: t.url,
      pinned: t.pinned,
      audible: t.audible,
      useRank: useRank.get(t.tabId) ?? null,
      barIndex,
      iconKey: t.iconKey,
    }));
    return {
      windowId,
      current: Math.max(
        0,
        tabs.findIndex(({ t }) => t.active),
      ),
      rows,
    };
  });

  const find = (target: TabRef): Cursor | null => {
    const window = windows.findIndex((w) => w.windowId === target.windowId);
    const row = windows[window]?.rows.findIndex((x) => x.tabId === target.tabId) ?? -1;
    return row >= 0 ? { window, row } : null;
  };
  // The most recent other tab within scope; tab order never changes it (C-TAP-03 to C-TAP-06).
  const candidates =
    settings.quickScope === 'window'
      ? windowList(r, source.windowId).map((tabId) => ({ tabId, windowId: source.windowId }))
      : listed;
  const target = candidates.find((t) => t.tabId !== source.tabId);
  const quick = target ? find(target) : null;
  const current = { window: 0, row: windows[0]?.current ?? 0 };
  const initial = settings.quickTap === 'list' ? current : (quick ?? current);
  return {
    source,
    windows,
    quick,
    initial,
    stack: settings.quickTap === 'flip' && settings.quickScope === 'all' ? stackOf(windows) : null,
    closed: settings.closedTabs === 'on' ? closed : [],
  };
}

// Never used rows follow the used ones in window, then row order.
const stackOf = (windows: readonly SnapWindow[]): Cursor[] =>
  windows
    .flatMap((w, window) => w.rows.map((r, row) => ({ cursor: { window, row }, rank: r.useRank ?? Infinity })))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.cursor);

export const rowAt = (s: Snapshot, c: Cursor) => s.windows[c.window]?.rows[c.row];

// What a row reference names: an open row in its window, a recently closed tab in the closed window after the listed
// ones (window === windows.length), or nothing (03 4.6).
export type NamedRow = { closed: false; window: SnapWindow; row: SnapRow } | { closed: true; row: ClosedTab };

export function rowOf(s: Snapshot, ref: RowRef): NamedRow | null {
  if (ref.window === s.windows.length) {
    const tab = s.closed[ref.row];
    return tab ? { closed: true, row: tab } : null;
  }
  const window = s.windows[ref.window];
  const row = window?.rows[ref.row];
  return window && row ? { closed: false, window, row } : null;
}

const listRow = (row: Pick<SnapRow, 'title' | 'url' | 'pinned' | 'audible'>): ListRow => ({
  title: fitText(row.title, TITLE_MAX),
  site: fitText(urlParts(row.url).host, SITE_MAX),
  pinned: row.pinned,
  audible: row.audible,
  icon: null,
});

// The one snapshot to host projection: display text cut to the protocol limits, icons later as patches (C-ICON-04).
export const listView = (s: Snapshot): ListView => ({
  windows: s.windows.map((w) => ({ current: w.current, rows: w.rows.map(listRow) })),
  closed: s.closed.map((tab) => listRow({ ...tab, pinned: false, audible: false })),
});

// The row's text for the host's copy keys, open or closed, its title cut as listView cuts it; null past URL_MAX
// (C-SRCH-26).
export function copyText(s: Snapshot, ref: RowRef): CopyText | null {
  const row = rowOf(s, ref)?.row;
  return row && row.url.length <= URL_MAX ? { title: fitText(row.title, TITLE_MAX), url: row.url } : null;
}

// Recently closed rows follow the listed windows, as the closed window (03 4.6).
export const iconKeys = (s: Snapshot): (string | null)[][] => [
  ...s.windows.map((w) => w.rows.map((row) => row.iconKey)),
  s.closed.map((tab) => tab.iconKey),
];

// Ranking reads full titles and addresses, so a match beyond the display cut still ranks (C-SRCH-19). Recently closed
// rows sit in the closed window after the listed ones, never used, in closing order (C-SRCH-27, 03 4.6).
export const candidates = (s: Snapshot): Candidate[] => [
  ...s.windows.flatMap((w, window) =>
    w.rows.map((row, i) => ({
      ref: { window, row: i },
      title: row.title,
      url: row.url,
      useRank: row.useRank,
      windowRank: window,
      barIndex: row.barIndex,
      closed: false,
    })),
  ),
  ...s.closed.map((tab, i) => ({
    ref: { window: s.windows.length, row: i },
    title: tab.title,
    url: tab.url,
    useRank: null,
    windowRank: s.windows.length,
    barIndex: i,
    closed: true,
  })),
];
