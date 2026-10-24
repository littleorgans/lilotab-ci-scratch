// Interaction tables TB-01 to TB-03 (07-tests 2.1). Each row replays events from the fixture in interaction-harness.ts
// and checks the last event's state, exit, switch and highlighted tab; the 04-state-machine 8 invariants run after
// every step of every row. Fixture recency, most recent first: 11, 21, 13, 12, 22, then never used 14, 23; window 1
// is the source window, 11 its current tab. Times count from the press.

import { describe, it } from 'vite-plus/test';
import {
  CLOSED,
  LIVE,
  activated,
  activity,
  check,
  clearData,
  close,
  enter,
  esc,
  focus,
  host,
  jump,
  latch,
  leave,
  move,
  page,
  pick,
  ping,
  press,
  query,
  ready,
  release,
  removed,
  searchKey,
  settingsChanged,
  status,
  stepKey,
  switchTo,
  tick,
  toolbar,
  win,
  type Row,
} from './interaction-harness.ts';

// Flip, hold delay 50: the list shows at 50, its 10 s idle due at 10050.
const HOLD = [press(0), ready(10), tick(50)];
// Open tab list: shown at ready, open at the release at 20, its 5 min idle due at 300020.
const LIST = { quickTap: 'list' } as const;
const OPEN = [press(0), ready(10), release(20)];
// Search latched at 60 on the hold cursor, its 5 min idle due at 300060.
const SEARCH = [...HOLD, latch(60)];
const ALL = { quickScope: 'all' } as const;
// Include recently closed tabs On, the closed tab Omega read at a toolbar click; its row is { window: 2, row: 0 }.
const CLOSED_ON = { closedTabs: 'on' } as const;
const OMEGA = [toolbar(0, { closed: CLOSED }), ready(10), query(20, 'omega')];

describe('TB-01 interaction.holdGesture', () => {
  it.each<Row>([
    {
      name: 'T-16 C-TAP-01: release before the hold delay commits the quick target',
      events: [press(0), ready(10), release(20)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(13) },
    },
    {
      name: 'T-06 C-SET-04: with hold delay 200 the list is still hidden at press plus 199',
      settings: { holdDelayMs: 200 },
      events: [press(0), ready(10), tick(199)],
      expect: { state: 'ready' },
    },
    {
      name: 'T-14 C-HOLD-01 C-HOLD-04: with hold delay 200 the list shows at press plus 200 on the quick target',
      settings: { holdDelayMs: 200 },
      events: [press(0), ready(10), tick(200)],
      expect: { state: 'holding', shown: 13 },
    },
    {
      name: 'T-14 C-HOLD-01: the host wake ping at press plus 50 shows the list (05-events 2.3)',
      events: [press(0), ready(10), ping(50)],
      expect: { state: 'holding', shown: 13 },
    },
    {
      name: 'T-17 C-HOLD-07: a move before the list shows shows it at once, moved',
      events: [press(0), ready(10), move(20, 1)],
      expect: { state: 'holding', shown: 12 },
    },
    {
      name: 'T-27 C-HOLD-09: release commits the highlighted row',
      events: [...HOLD, move(60, 1), release(70)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(12) },
    },
    {
      name: 'T-47 C-HOLD-09: release on the current tab switches nothing',
      events: [...HOLD, move(60, -1), release(70)],
      expect: { state: 'idle', exit: 'commit' },
    },
    {
      name: 'T-28 C-HOLD-12: after a missed release the next unheld input commits',
      events: [...HOLD, release(60, true)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(13) },
    },
    {
      name: 'T-29 C-HOLD-10 KB-07: Esc cancels, held key down or released unseen',
      events: [...HOLD, esc(60)],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'T-33 C-HOLD-11: another tab activated in the source window cancels',
      events: [...HOLD, activated(60, 12)],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'T-32 C-HOLD-13: 10 s without input cancels',
      events: [...HOLD, tick(10_050)],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'C-HOLD-21: a press 10.1 s after the last input ends the hold and starts a new gesture',
      events: [...HOLD, press(10_150)],
      expect: { state: 'overlayPending', exit: 'cancel' },
    },
    {
      name: 'T-05 C-HOLD-23: a press in another tab cancels the list and starts a new gesture',
      events: [...HOLD, press(60, 21)],
      expect: { state: 'overlayPending', exit: 'cancel' },
    },
    {
      name: 'T-24 C-WIN-05 C-WIN-07: Right, then release commits the other window current tab and focuses it',
      events: [...HOLD, win(60, 1), release(70)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(21, true) },
    },
    {
      name: 'T-25 C-WIN-10: with one listed window Right keeps the row',
      live: LIVE.one,
      events: [...HOLD, win(60, 1)],
      expect: { state: 'holding', shown: 13 },
    },
    {
      name: 'T-34 T-59 C-HOLD-14: a listed tab closed meanwhile stays listed, and committing on it switches nothing',
      events: [...HOLD, removed(60, 12), move(70, 1), release(80)],
      expect: { state: 'idle', exit: 'commit' },
    },
    {
      name: 'T-02 C-HOLD-15: one tab in total does nothing',
      live: LIVE.single,
      events: [press(0)],
      expect: { state: 'idle' },
    },
    {
      name: 'T-53 C-SET-12: a scope changed mid list leaves the live list stepping within its window',
      events: [...HOLD, settingsChanged(60, ALL), press(70)],
      expect: { state: 'holding', shown: 12 },
    },
    {
      name: 'T-50 C-DATA-05: clear mid list keeps the list',
      events: [...HOLD, clearData(60), release(70)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(13) },
    },
    // Window 1 Recent rows: 11, 13, 12, 14; the cursor starts on 13.
    {
      name: 'T-74 C-SRCH-25 C-HOLD-27: the close key closes the cursor tab and moves to the next row',
      events: [...HOLD, close(60)],
      expect: { state: 'holding', shown: 12, closed: 13 },
    },
    {
      name: 'T-74 C-HOLD-14: Up then skips the gone row',
      events: [...HOLD, close(60), move(70, -1)],
      expect: { state: 'holding', shown: 11 },
    },
    {
      name: 'T-74 C-SRCH-25: on the last row the cursor moves to the previous one',
      events: [...HOLD, move(60, 1), move(70, 1), close(80)],
      expect: { state: 'holding', shown: 12, closed: 14 },
    },
    {
      name: 'T-76 C-SRCH-25: the close key on the current tab does nothing',
      events: [...HOLD, move(60, -1), close(70)],
      expect: { state: 'holding', shown: 11, closed: null },
    },
  ])('$name', check);

  // A quick tap at hold delay 0. The dwell is due at the press, so it expires before the ready host's
  // status (T-13); the ready host shows the list at once (T-07), and the release commits the cursor (T-27).
  it.each<Row>([
    {
      name: 'T-13 T-07 C-HOLD-01: hold delay 0, a ready host shows the list at once on the quick target',
      settings: { holdDelayMs: 0 },
      events: [press(0), ready(10)],
      expect: { state: 'holding', shown: 13 },
    },
    {
      name: 'T-27 C-TAP-01: hold delay 0, a quick tap switches to the quick target',
      settings: { holdDelayMs: 0 },
      events: [press(0), ready(10), release(20)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(13) },
    },
  ])('$name', check);

  it.each<Row>([
    {
      name: 'T-07 C-HOLD-24: Open tab list ignores a 200 ms hold delay and shows the current tab once ready',
      settings: { ...LIST, holdDelayMs: 200 },
      events: [press(0), ready(10)],
      expect: { state: 'holding', shown: 11 },
    },
    {
      name: 'T-68 C-TAP-10: a release on the current tab opens the list',
      settings: LIST,
      events: OPEN,
      expect: { state: 'holding.open', shown: 11 },
    },
    {
      name: 'T-68 C-HOLD-12: an inferred release on the current tab opens the list',
      settings: LIST,
      events: [press(0), ready(10), release(20, true)],
      expect: { state: 'holding.open' },
    },
    {
      name: 'T-70 C-TAP-11: in the open list Down, then Enter commits the next tab',
      settings: LIST,
      events: [...OPEN, move(30, 1), enter(40)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(13) },
    },
    {
      name: 'T-71 C-TAP-11: in the open list a row pick commits that row',
      settings: LIST,
      events: [...OPEN, pick(30, 22)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(22, true) },
    },
    {
      name: 'T-59 C-HOLD-14: an open list stale pick after close switches nothing before tabRemoved',
      settings: LIST,
      events: [...OPEN, move(30, 1), close(40), pick(50, 13)],
      expect: { state: 'idle', exit: 'commit' },
    },
    {
      name: 'T-29 C-TAP-11: Esc cancels the open list',
      settings: LIST,
      events: [...OPEN, esc(30)],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'T-73 T-72 C-TAP-11: a ping leaves the 5 min due, which then cancels',
      settings: LIST,
      events: [...OPEN, ping(100_000), tick(300_020)],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'T-69 C-TAP-11: a release in the open list does nothing and leaves the 5 min due',
      settings: LIST,
      events: [...OPEN, release(100_000), tick(300_020)],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'T-26 C-TAP-11: activity restarts the 5 min due',
      settings: LIST,
      events: [...OPEN, activity(100_000), tick(300_020)],
      expect: { state: 'holding.open' },
    },
    {
      name: 'T-22 C-HOLD-21: a same source press after 10 s, before 5 min, steps the open list',
      settings: LIST,
      events: [...OPEN, press(10_120)],
      expect: { state: 'holding.open', shown: 13 },
    },
    {
      name: 'T-53 C-SET-12: Quick tap changed to Flip before the release still opens the list',
      settings: LIST,
      events: [press(0), ready(10), settingsChanged(15, { quickTap: 'flip' }), release(20)],
      expect: { state: 'holding.open' },
    },
    {
      name: 'T-50 C-HOLD-14: clear while open keeps the snapshot rows',
      settings: LIST,
      events: [...OPEN, clearData(30), move(40, 1), enter(50)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(13) },
    },
    // C-HOLD-24: the shortcut moves the visible order whatever the scope; with All windows this is D8 (no history).
    ...(
      [
        ['Recent', 'This window', 'recent', 'window', 13],
        ['Recent', 'All windows', 'recent', 'all', 13],
        ['Window order', 'This window', 'window', 'window', 12],
        ['Window order', 'All windows', 'window', 'all', 12],
      ] as const
    ).map(([order, scope, tabOrder, quickScope, tab]): Row => ({
      name: `C-HOLD-24 D8: Open tab list, ${order}, ${scope}: hold, the shortcut again, release commits the next row`,
      settings: { ...LIST, tabOrder, quickScope },
      events: [press(0), ready(10), press(20), release(30)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(tab) },
    })),
  ])('$name', check);

  // Global history stepping (C-WIN-06; global step D1, D4, D6, D7, D9). Flip with All windows: the list opens on 21 in
  // window 2; the stack runs 11, 21, 13, 12, 22, 14, 23.
  it.each<Row>([
    {
      name: 'T-22 C-WIN-06 C-SET-03: with This window the shortcut moves down the shown list',
      events: [...HOLD, press(60)],
      expect: { state: 'holding', shown: 12 },
    },
    {
      name: 'T-22 C-WIN-06 D1: with All windows a press steps one tab back, the shown window following',
      settings: ALL,
      events: [...HOLD, press(60)],
      expect: { state: 'holding', shown: 13 },
    },
    {
      name: 'C-WIN-06 D7: never activated tabs come after the least recent used tab',
      settings: ALL,
      events: [...HOLD, press(60), press(70), press(80), press(90)],
      expect: { state: 'holding', shown: 14 },
    },
    {
      name: 'C-WIN-06 D4: past the last tab a press wraps to the current tab',
      settings: ALL,
      events: [...HOLD, press(60), press(70), press(80), press(90), press(100), press(110)],
      expect: { state: 'holding', shown: 11 },
    },
    {
      name: 'T-23 C-WIN-06 D4: Shift from the top wraps to the last tab',
      settings: ALL,
      events: [...HOLD, stepKey(60, -1), stepKey(70, -1)],
      expect: { state: 'holding', shown: 23 },
    },
    {
      name: 'T-23 C-WIN-06 D6: after Down the shortcut moves down the shown list',
      settings: ALL,
      events: [...HOLD, move(60, 1), press(70)],
      expect: { state: 'holding', shown: 23 },
    },
    {
      name: 'T-24 C-WIN-06 D6: after Right the shortcut moves down the shown list',
      settings: ALL,
      events: [...HOLD, win(60, 1), press(70)],
      expect: { state: 'holding', shown: 13 },
    },
    {
      name: 'T-25 C-WIN-06 D9: with one listed window Right still ends history stepping',
      settings: { ...ALL, tabOrder: 'window' },
      live: LIVE.one,
      events: [...HOLD, win(60, 1), press(70)],
      expect: { state: 'holding', shown: 14 },
    },
    {
      name: 'T-31 T-67 C-WIN-06: a search round trip keeps history stepping',
      settings: ALL,
      events: [...HOLD, latch(60), leave(70), press(80)],
      expect: { state: 'holding', shown: 13 },
    },
  ])('$name', check);
});

describe('TB-02 interaction.hostChoice', () => {
  const POPUP = { listSurface: 'popup' } as const;
  it.each<Row>([
    {
      name: 'T-04 C-POP-02: list surface Popup opens the popup',
      settings: POPUP,
      events: [press(0)],
      expect: { state: 'popupPending' },
    },
    {
      name: 'T-08 T-09 C-POP-01: an overlay decline falls back to the popup, accepted when ready',
      events: [press(0), status(10, 'declined'), ready(20)],
      expect: { state: 'ready' },
    },
    {
      name: 'T-11 C-POP-05 C-TAP-09: no host by 500 ms commits the quick target',
      events: [press(0), tick(500)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(13) },
    },
    {
      name: 'T-12 C-TAP-09: a popup that cannot open commits the quick target',
      settings: POPUP,
      events: [press(0), status(10, 'failed')],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(13) },
    },
    {
      name: 'T-57 T-63 C-POP-05: focus lost, then the deadline cancels',
      settings: POPUP,
      events: [press(0), focus(10, null), tick(500)],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'T-57 T-10 C-POP-05: focus lost, then a popup ready in time is accepted',
      settings: POPUP,
      events: [press(0), focus(10, null), ready(100)],
      expect: { state: 'holding', shown: 13 },
    },
    {
      name: 'T-20 C-POP-04: a popup closed before ready cancels',
      settings: POPUP,
      events: [press(0), status(10, 'closed')],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'T-56 C-WIN-08: focus lost while the overlay launches cancels',
      events: [press(0), focus(10, null)],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'T-51 C-SEC-02: a late ready of a retired attempt is ignored',
      events: [press(0), status(10, 'declined'), ready(20, 1)],
      expect: { state: 'popupPending' },
    },
    {
      name: 'T-20 T-51 KB-04: source left while the overlay launches cancels, and its late failure switches nothing',
      events: [press(0), activated(10, 12), status(20, 'failed', 1)],
      expect: { state: 'idle' },
    },
    {
      name: 'T-11 T-51 KB-10 C-POP-11: a popup ready after the deadline is refused, and the popup closes',
      settings: POPUP,
      events: [press(0), ready(600)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(13) },
    },
    {
      name: 'T-55 T-61 C-POP-09: a toolbar click opens search in the popup, even on a web page',
      events: [toolbar(0), ready(10)],
      expect: { state: 'search', host: 'popup' },
    },
    {
      name: 'T-79 T-61 C-KEY-12: the Search tabs command on a web page opens search in the overlay',
      events: [searchKey(0), ready(10)],
      expect: { state: 'search', host: 'overlay' },
    },
    {
      name: 'T-79 T-61 C-KEY-12 C-POP-01: the Search tabs command on a browser page opens search in the popup',
      events: [searchKey(0, { url: 'chrome://newtab/' }), ready(10)],
      expect: { state: 'search', host: 'popup' },
    },
    {
      name: 'T-79 C-KEY-12: a Search tabs press during a hold cancels it and opens search',
      events: [...HOLD, searchKey(60)],
      expect: { state: 'overlayPending', exit: 'cancel', host: 'overlay' },
    },
    {
      name: 'T-62 C-POP-09: a toolbar popup that fails cancels',
      events: [toolbar(0), status(10, 'failed')],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'T-08 T-68 C-POP-03: Open tab list in the popup fallback opens on a release',
      settings: LIST,
      events: [press(0), status(10, 'declined'), ready(20), release(30)],
      expect: { state: 'holding.open' },
    },
    {
      name: 'T-11 T-47 C-TAP-09: Open tab list with no ready host by 500 ms switches nothing',
      settings: LIST,
      events: [press(0), tick(500)],
      expect: { state: 'idle', exit: 'commit' },
    },
    {
      name: 'T-15 T-11 C-TAP-09: Open tab list, a press before the deadline steps, and the deadline commits that row',
      settings: LIST,
      events: [press(0), press(100), tick(500)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(13) },
    },
    {
      name: 'T-55 T-61 C-POP-09: with Open tab list a toolbar click still opens search',
      settings: LIST,
      events: [toolbar(0), ready(10)],
      expect: { state: 'search' },
    },
  ])('$name', check);
});

describe('TB-03 interaction.search', () => {
  it.each<Row>([
    {
      name: 'T-18 C-SRCH-01 C-SRCH-08: held F before the list shows opens search at once on the cursor tab',
      events: [press(0), ready(10), latch(20)],
      expect: { state: 'search', shown: 13 },
    },
    {
      name: 'T-41 C-SRCH-03: a release in search keeps the list',
      events: [...SEARCH, release(70)],
      expect: { state: 'search' },
    },
    {
      name: 'T-35 C-SRCH-11: typing moves the highlight to the first result',
      events: [...SEARCH, query(70, 'ta')],
      expect: { state: 'search', shown: 21 },
    },
    {
      name: 'T-38 C-SRCH-13: Enter commits a result in another window and focuses it',
      events: [...SEARCH, query(70, 'delta'), enter(80)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(21, true) },
    },
    {
      name: 'T-39 C-SRCH-17: a click on a stale frame commits the row clicked',
      events: [...SEARCH, query(70, 'delta'), pick(80, 22)],
      expect: { state: 'idle', exit: 'commit', activate: switchTo(22, true) },
    },
    {
      name: 'T-40 C-SRCH-16: with no results Enter does nothing',
      events: [...SEARCH, query(70, 'zzz'), enter(80)],
      expect: { state: 'search' },
    },
    {
      name: 'T-43 C-SRCH-14: Esc cancels',
      events: [...SEARCH, esc(70)],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'T-42 C-SRCH-15: Left and Right do nothing',
      events: [...SEARCH, win(70, 1)],
      expect: { state: 'search', shown: 13 },
    },
    {
      name: 'T-45 T-46 C-SRCH-22: a ping leaves the 5 min due, which then cancels',
      events: [...SEARCH, ping(100_000), tick(300_060)],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'T-66 C-SRCH-22: a key press restarts the 5 min due',
      events: [...SEARCH, activity(100_000), tick(300_060)],
      expect: { state: 'search' },
    },
    {
      name: 'T-67 C-SRCH-20: held F back to hold keeps a highlight the shown window lists',
      events: [...SEARCH, move(70, 1), leave(80)],
      expect: { state: 'holding', shown: 12 },
    },
    {
      name: 'T-67 C-SRCH-20: held F back to hold returns to the first highlight when the shown window lacks it',
      events: [...SEARCH, move(70, 1), move(80, 1), leave(90)],
      expect: { state: 'holding', shown: 13 },
    },
    {
      name: 'T-67 C-SRCH-20: back in hold the 10 s timeout applies again',
      events: [...SEARCH, leave(70), tick(10_070)],
      expect: { state: 'idle', exit: 'cancel' },
    },
    {
      name: 'C-SRCH-20: a toolbar list ignores held F',
      events: [toolbar(0), ready(10), leave(20)],
      expect: { state: 'search' },
    },
    {
      name: 'T-67 C-TAP-11: Open tab list, F then held F returns to the open list',
      settings: LIST,
      events: [...OPEN, latch(30), leave(40)],
      expect: { state: 'holding.open' },
    },
    // The empty query lists 11, 21, 13, 12, 22, 14, 23; the latch highlights 13, the third.
    {
      name: 'T-75 C-SRCH-25: the close key ranks again without the gone row and keeps the highlight index',
      events: [...SEARCH, close(70)],
      expect: { state: 'search', shown: 12, closed: 13 },
    },
    {
      name: 'T-59 C-HOLD-14: a search stale pick after close switches nothing before tabRemoved',
      events: [...SEARCH, close(70), pick(80, 13)],
      expect: { state: 'idle', exit: 'commit' },
    },
    {
      name: 'T-77 T-75 C-SRCH-23: End highlights the last result; closing it highlights the new last result',
      events: [...SEARCH, jump(70, 'last'), close(80)],
      expect: { state: 'search', shown: 14, closed: 23 },
    },
    {
      name: 'T-77 C-SRCH-24: Page Down stops at the last result',
      events: [...SEARCH, page(70, 1, 5)],
      expect: { state: 'search', shown: 23 },
    },
    {
      name: 'T-77 C-SRCH-24: Page Up stops at the first result',
      events: [...SEARCH, page(70, -1, 5)],
      expect: { state: 'search', shown: 11 },
    },
    {
      name: 'T-77 C-SRCH-22: with no results Home only restarts the 5 min due',
      events: [...SEARCH, query(70, 'zzz'), jump(100_000, 'first'), tick(300_070)],
      expect: { state: 'search' },
    },
    {
      name: 'T-78 C-SRCH-28: Enter on a recently closed row reopens it and switches nothing',
      settings: CLOSED_ON,
      events: [...OMEGA, enter(30)],
      expect: { state: 'idle', exit: 'commit', restored: 's1' },
    },
    {
      name: 'T-78 C-SRCH-28: a click on a recently closed row reopens it and switches nothing',
      settings: CLOSED_ON,
      events: [...OMEGA, host(30, { kind: 'pick', row: { window: 2, row: 0 } })],
      expect: { state: 'idle', exit: 'commit', restored: 's1' },
    },
    {
      name: 'T-76 C-SRCH-25: the close key on a recently closed row does nothing',
      settings: CLOSED_ON,
      events: [...OMEGA, close(30)],
      expect: { state: 'search', closed: null, restored: null },
    },
  ])('$name', check);
});
