// TB-04 snapshot.build (07-tests 2.1): the list frozen at a press from recents, live facts, settings and source tab.

import { describe, expect, it } from 'vite-plus/test';
import {
  DEFAULTS,
  buildSnapshot,
  candidates,
  copyText,
  listView,
  reconcile,
  rowAt,
  type ClosedTab,
  type Cursor,
  type ListRow,
  type LiveFacts,
  type Recents,
  type Settings,
  type Snapshot,
  type TabRef,
} from '../src/core/index.ts';
import { close, focus, history, live, tab, use, win, type Step } from './data-fixtures.ts';

// A press as the worker makes it: reconcile with the press's live facts, then build (T-03).
function press(
  r: Recents,
  facts: LiveFacts,
  settings: Partial<Settings> = {},
  source?: TabRef,
  closed: readonly ClosedTab[] = [],
): Snapshot {
  const w = facts.windows[0];
  const from = source ?? { tabId: w?.tabs.find((t) => t.active)?.tabId ?? -1, windowId: w?.windowId ?? -1 };
  const s = buildSnapshot(reconcile(r, facts), facts, { ...DEFAULTS, ...settings }, from, closed);
  if (!s) throw new Error('no snapshot');
  return s;
}

const tabAt = (s: Snapshot, c: Cursor) => rowAt(s, c)?.tabId ?? null;

// What a user sees of the snapshot, by tab and window id.
const outline = (s: Snapshot) => ({
  windows: s.windows.map((w) => w.windowId),
  rows: s.windows.map((w) => w.rows.map((r) => r.tabId)),
  quick: s.quick && tabAt(s, s.quick),
  initial: { windowId: s.windows[s.initial.window]?.windowId, tabId: tabAt(s, s.initial) },
  stack: s.stack && s.stack.map((c) => tabAt(s, c)),
});

// One window, bar order 1 to 5, tab 3 active.
const L1 = live(win(1, 3, 1, 2, 3, 4, 5));
// Two windows; global order 12, 22, 21, 11; tab 13 never used; window 1 focused last.
const L2 = live(win(1, 12, 11, 12, 13), win(2, 22, 21, 22));
const H2 = history(L2, use(11, 1), use(12, 1), focus(2), use(21, 2), use(22, 2), focus(1));

describe('TB-04 snapshot.build', () => {
  it.each<{ name: string; r: Recents; facts: LiveFacts; settings?: Partial<Settings>; expected: object }>([
    {
      name: 'C-HOLD-02 Recent order: current tab, then by use, then never used in tab bar order',
      r: history(L1, use(5, 1), use(2, 1), use(3, 1)),
      facts: L1,
      expected: { rows: [[3, 2, 5, 1, 4]] },
    },
    {
      name: 'C-HOLD-03 Window order lists the tab bar order',
      r: history(L1, use(5, 1), use(2, 1), use(3, 1)),
      facts: L1,
      settings: { tabOrder: 'window' },
      expected: { rows: [[1, 2, 3, 4, 5]] },
    },
    {
      name: 'C-TAP-03 C-HOLD-04 This window: quick target and first highlight stay in the source window',
      r: H2,
      facts: L2,
      expected: { quick: 11, initial: { windowId: 1, tabId: 11 } },
    },
    {
      name: 'C-TAP-04 C-HOLD-04 All windows: quick target is the most recent other tab, and the list opens on its window',
      r: H2,
      facts: L2,
      settings: { quickScope: 'all' },
      expected: { quick: 22, initial: { windowId: 2, tabId: 22 } },
    },
    {
      name: 'C-TAP-05 tab order never changes the quick target',
      r: history(L1, use(5, 1), use(3, 1)),
      facts: L1,
      settings: { tabOrder: 'window' },
      expected: { quick: 5 },
    },
    {
      name: 'C-TAP-06 previous tab closed: the quick target is the next most recent',
      r: history(L1, use(4, 1), use(2, 1), use(3, 1), close(2, 1)),
      facts: live(win(1, 3, 1, 3, 4, 5)),
      expected: { quick: 4 },
    },
    {
      name: 'C-TAP-07 C-HOLD-05 nothing to go back to: no quick target, the first highlight is the current tab',
      r: history(L1),
      facts: L1,
      expected: { quick: null, initial: { windowId: 1, tabId: 3 } },
    },
    {
      name: 'C-WIN-09 a single tab window is listed beside the others',
      r: history(live(win(1, 1, 1, 2), win(2, 3, 3))),
      facts: live(win(1, 1, 1, 2), win(2, 3, 3)),
      expected: { windows: [1, 2], rows: [[1, 2], [3]] },
    },
    {
      name: 'C-WIN-02 strip order: source window, then by most recent focus',
      r: history(live(win(1, 1, 1), win(2, 2, 2), win(3, 3, 3)), focus(2), focus(3), focus(1)),
      facts: live(win(1, 1, 1), win(2, 2, 2), win(3, 3, 3)),
      expected: { windows: [1, 3, 2] },
    },
    {
      name: 'C-WIN-11 windows never focused follow in browser order',
      r: history(live(win(1, 1, 1), win(2, 2, 2), win(3, 3, 3), win(4, 4, 4)), focus(4), focus(1)),
      facts: live(win(1, 1, 1), win(2, 2, 2), win(3, 3, 3), win(4, 4, 4)),
      expected: { windows: [1, 4, 2, 3] },
    },
    {
      name: 'C-WIN-14 C-PRIV-08 a tab used in a window live facts do not list (popup, DevTools) is never listed or targeted',
      r: history(live(win(1, 2, 1, 2)), use(1, 1), use(91, 9), use(2, 1)),
      facts: live(win(1, 2, 1, 2)),
      settings: { quickScope: 'all' },
      expected: { windows: [1], rows: [[2, 1]], quick: 1 },
    },
  ])('$name', ({ r, facts, settings, expected }) => {
    expect(outline(press(r, facts, settings))).toMatchObject(expected);
  });

  // Planned row, build spec 5 item 3: Open tab list opens on the current tab (C-HOLD-24, C-SET-19).
  it.each([
    { quickScope: 'window', tabOrder: 'recent' },
    { quickScope: 'window', tabOrder: 'window' },
    { quickScope: 'all', tabOrder: 'recent' },
    { quickScope: 'all', tabOrder: 'window' },
  ] as const)(
    'C-HOLD-24 Open tab list: first highlight is the current tab in the source window ($quickScope, $tabOrder)',
    (settings) => {
      expect(outline(press(H2, L2, { ...settings, quickTap: 'list' })).initial).toEqual({ windowId: 1, tabId: 12 });
    },
  );

  // Global history stepping (global-step D7, D8): the order held presses walk in All windows.
  // Source window 2; global order 22, 11, 12; never used: 13 in window 1, 21 and 23 in window 2.
  const L3 = live(win(1, 11, 11, 12, 13), win(2, 22, 21, 22, 23));
  const H3 = history(L3, use(12, 1), use(11, 1), focus(2));
  const from2 = { tabId: 22, windowId: 2 };
  it.each<{ name: string; settings: Partial<Settings>; stack: number[] | null }>([
    {
      name: 'C-WIN-06 All windows: steps walk the global recent order, never used tabs last in strip then tab bar order',
      settings: { quickScope: 'all' },
      stack: [22, 11, 12, 21, 23, 13],
    },
    {
      name: 'C-WIN-06 This window: no global steps',
      settings: { quickScope: 'window' },
      stack: null,
    },
    {
      name: 'C-HOLD-24 C-SET-19 Open tab list: no global steps, whatever the scope (global-step D8)',
      settings: { quickScope: 'all', quickTap: 'list' },
      stack: null,
    },
  ])('$name', ({ settings, stack }) => {
    expect(outline(press(H3, L3, settings, from2)).stack).toEqual(stack);
  });

  // Read at the press, most recent first; ranking finds them in the closed window after the listed ones.
  const CLOSED: ClosedTab[] = [
    { sessionId: 's9', title: 'Closed last', url: 'https://last.example/', iconKey: null },
    { sessionId: 's8', title: 'Closed before', url: 'https://before.example/', iconKey: null },
  ];
  it.each<{ name: string; settings: Partial<Settings>; closed: object[] }>([
    {
      name: 'C-SRCH-27 recently closed tabs become candidates after both windows, never used, in closing order',
      settings: { closedTabs: 'on' },
      closed: [
        { ref: { window: 2, row: 0 }, title: 'Closed last', useRank: null, windowRank: 2, barIndex: 0 },
        { ref: { window: 2, row: 1 }, title: 'Closed before', useRank: null, windowRank: 2, barIndex: 1 },
      ],
    },
    { name: 'C-SET-22 Off: no recently closed tabs', settings: { closedTabs: 'off' }, closed: [] },
  ])('$name', ({ settings, closed }) => {
    const s = press(H2, L2, settings, undefined, CLOSED);
    expect(candidates(s).filter((c) => c.closed)).toMatchObject(closed);
    expect(s.closed).toHaveLength(closed.length);
  });

  it('C-SRCH-27 C-SRCH-26 recently closed rows reach the host as rows, and copy as an open row does', () => {
    const s = press(H2, L2, { closedTabs: 'on' }, undefined, CLOSED);
    expect(listView(s).closed).toEqual([
      { title: 'Closed last', site: 'last.example', pinned: false, audible: false, icon: null },
      { title: 'Closed before', site: 'before.example', pinned: false, audible: false, icon: null },
    ]);
    expect(copyText(s, { window: 2, row: 1 })).toEqual({ title: 'Closed before', url: 'https://before.example/' });
  });

  // The rows hosts paint, through the one snapshot to host projection.
  it.each<{ name: string; facts: LiveFacts; steps?: Step[]; rows: Partial<ListRow>[] }>([
    {
      name: 'C-HOLD-16 a pinned tab keeps its recency place, with the pinned flag',
      facts: live(win(1, 3, tab(1, { title: 'Pinned', pinned: true }), 2, 3)),
      steps: [use(2, 1), use(3, 1)],
      rows: [
        { title: 'Tab 3', pinned: false },
        { title: 'Tab 2', pinned: false },
        { title: 'Pinned', pinned: true },
      ],
    },
    {
      name: 'C-HOLD-17 an untitled tab carries its host, else nothing, for the host to show "Untitled"',
      facts: live(
        win(
          1,
          2,
          tab(1, { title: '', url: 'about:blank' }),
          tab(2, { title: '', url: 'https://user@Docs.Example.com:8443/a' }),
        ),
      ),
      rows: [
        { title: '', site: 'docs.example.com' },
        { title: '', site: '' },
      ],
    },
    {
      name: 'C-HOLD-25 playing sound at the press survives to the host row, true and false',
      facts: live(win(1, 1, tab(1, { audible: true }), tab(2, { audible: false }))),
      rows: [{ audible: true }, { audible: false }],
    },
  ])('$name', ({ facts, steps = [], rows }) => {
    expect(listView(press(history(facts, ...steps), facts)).windows[0]?.rows).toMatchObject(rows);
  });
});
