// Shared driver for the interaction tables TB-01 to TB-03 (07-tests 2.1): a fixed two window fixture with known
// recency, event builders that read the live model, a replay that checks the invariants of 04-state-machine 8 after
// every step, and the visible outcome of the last event.

import { expect } from 'vite-plus/test';
import {
  init,
  step,
  type ClosedTab,
  type CoreEvent,
  type Effect,
  type HostInput,
  type HostStatus,
  type Interaction,
  type LiveFacts,
  type Model,
  type Settings,
  type TabId,
  type WindowId,
} from '../src/core/index.ts';
import { live, tab, win as windowFacts } from './data-fixtures.ts';
import { CMD_E } from './host-fixtures.ts';

// ---- fixture

const T0 = 1_000; // the press time; every row's offsets count from it

// Tab bar order per window; the first tab of each is active. 14 and 23 are never activated.
const TABS: Record<WindowId, readonly [TabId, string][]> = {
  1: [
    [11, 'Alpha'],
    [12, 'Beta'],
    [13, 'Gamma'],
    [14, 'Theta'],
  ],
  2: [
    [21, 'Delta'],
    [22, 'Epsilon'],
    [23, 'Zeta'],
  ],
};

const windowOfTab = (tabId: TabId): WindowId => (tabId < 20 ? 1 : 2);

const liveOf = (windows: readonly WindowId[], only?: TabId): LiveFacts =>
  live(
    ...windows.map((windowId) => {
      const tabs = (TABS[windowId] ?? [])
        .filter(([tabId]) => only === undefined || tabId === only)
        .map(([tabId, title]) => tab(tabId, { title, url: `https://${title.toLowerCase()}.example/` }));
      return windowFacts(windowId, tabs[0]?.tabId ?? -1, ...tabs);
    }),
  );

// Recency before the press, as browser events in order; focusing a window also uses its active tab. Global order:
// 11, 21, 13, 12, 22, then never used 14, 23. Window 1 Recent rows: 11, 13, 12, 14; Window order: 11, 12, 13, 14.
// Quick target: 13 with This window, 21 with All windows.
const HISTORY: readonly (['focus', WindowId] | ['tab', TabId])[] = [
  ['focus', 2],
  ['tab', 22],
  ['tab', 21],
  ['focus', 1],
  ['tab', 12],
  ['tab', 13],
  ['tab', 11],
  ['focus', 2],
  ['focus', 1],
];

export const LIVE = {
  two: liveOf([1, 2]),
  one: liveOf([1]), // one listed window (T-25, C-WIN-10)
  single: liveOf([1], 11), // one tab in total (T-02, C-HOLD-15)
};

function base(settings: Partial<Settings>, live: LiveFacts): Model {
  const listed = new Set(live.windows.flatMap((w) => w.tabs.map((t) => t.tabId)));
  let model = init('boot', undefined, { version: 1, ...settings }, live).model;
  let at = 0;
  for (const [kind, id] of HISTORY) {
    const windowId = kind === 'focus' ? id : windowOfTab(id);
    if (!live.windows.some((w) => w.windowId === windowId)) continue;
    const event: CoreEvent =
      kind === 'focus'
        ? { kind: 'windowFocused', at: ++at, windowId }
        : { kind: 'tabActivated', at: ++at, tabId: id, windowId };
    if (kind === 'focus' || listed.has(id)) model = step(model, event).model;
  }
  return model;
}

// ---- events: built when stepped, so host events can name the live attempt

interface Ctx {
  model: Model;
  live: LiveFacts;
  last: string | null; // the latest interaction id, live or ended
}
export type Ev = (ctx: Ctx) => CoreEvent;

const urlOf = (tabId: TabId) => `https://${TABS[windowOfTab(tabId)]?.find(([t]) => t === tabId)?.[1] ?? ''}.example/`;

// n names attempt n of the latest interaction; without it the active attempt, or the latest interaction's first.
const attemptOf = (ctx: Ctx, n?: number): string => {
  const active = ctx.model.interaction?.attempt.id;
  return n === undefined && active ? active : `${ctx.last ?? 'none'}:${String(n ?? 1)}`;
};

export const press =
  (at: number, tabId: TabId = 11): Ev =>
  ({ live }) => ({
    kind: 'command',
    at: T0 + at,
    source: { tabId, windowId: windowOfTab(tabId), url: urlOf(tabId) },
    binding: CMD_E,
    live,
    closed: [],
  });
// One recently closed tab, read at a search entry press; with two listed windows its row is { window: 2, row: 0 }.
export const CLOSED: readonly ClosedTab[] = [
  { sessionId: 's1', title: 'Omega', url: 'https://omega.example/', iconKey: null },
];
const searchPress =
  (kind: 'toolbarClicked' | 'searchCommand') =>
  (at: number, { url = urlOf(11), closed = [] as readonly ClosedTab[] } = {}): Ev =>
  ({ live }) => ({ kind, at: T0 + at, source: { tabId: 11, windowId: 1, url }, binding: CMD_E, live, closed });
export const toolbar = searchPress('toolbarClicked');
export const searchKey = searchPress('searchCommand'); // the Search tabs command (C-KEY-12)
export const status =
  (at: number, s: HostStatus, n?: number): Ev =>
  (ctx) => ({ kind: 'hostStatus', at: T0 + at, attempt: attemptOf(ctx, n), status: s });
export const ready = (at: number, n?: number): Ev => status(at, 'ready', n);
export const host =
  (at: number, input: HostInput, attempt?: string): Ev =>
  (ctx) => ({ kind: 'host', at: T0 + at, attempt: attempt ?? attemptOf(ctx), input });
export const tick =
  (at: number): Ev =>
  (ctx) => ({ kind: 'timer', at: T0 + at, id: ctx.last ?? 'none', timer: 'idle' });

export const release = (at: number, inferred = false) => host(at, { kind: 'release', inferred });
export const move = (at: number, delta: 1 | -1) => host(at, { kind: 'move', delta });
export const stepKey = (at: number, delta: 1 | -1) => host(at, { kind: 'step', delta }); // held letter or Shift form
export const win = (at: number, delta: 1 | -1) => host(at, { kind: 'window', delta });
export const latch = (at: number) => host(at, { kind: 'latchSearch' });
export const leave = (at: number) => host(at, { kind: 'leaveSearch' });
export const query = (at: number, text: string) => host(at, { kind: 'query', text });
export const enter = (at: number) => host(at, { kind: 'enter' });
export const ping = (at: number) => host(at, { kind: 'ping' });
export const activity = (at: number) => host(at, { kind: 'activity' });
export const esc = (at: number) => host(at, { kind: 'cancel', cause: 'key' });
export const close = (at: number) => host(at, { kind: 'close' });
export const jump = (at: number, to: 'first' | 'last') => host(at, { kind: 'jump', to });
export const page = (at: number, delta: 1 | -1, rows: number) => host(at, { kind: 'page', delta, rows });
export const pick =
  (at: number, tabId: TabId): Ev =>
  (ctx) =>
    host(at, { kind: 'pick', row: rowOf(ctx.model.interaction, tabId) })(ctx);

export const focus =
  (at: number, windowId: WindowId | null): Ev =>
  () => ({ kind: 'windowFocused', at: T0 + at, windowId });
export const activated =
  (at: number, tabId: TabId): Ev =>
  () => ({ kind: 'tabActivated', at: T0 + at, tabId, windowId: windowOfTab(tabId) });
export const removed =
  (at: number, tabId: TabId): Ev =>
  () => ({ kind: 'tabRemoved', at: T0 + at, tabId, windowId: windowOfTab(tabId), windowClosing: false });
export const settingsChanged =
  (at: number, settings: Partial<Settings>): Ev =>
  () => ({ kind: 'settingsChanged', at: T0 + at, settings: { version: 1, ...settings } });
export const clearData =
  (at: number): Ev =>
  ({ live }) => ({ kind: 'clearData', at: T0 + at, live, request: 1 });

function rowOf(i: Interaction | null, tabId: TabId) {
  const windows = i?.snapshot.windows ?? [];
  const window = windows.findIndex((w) => w.rows.some((r) => r.tabId === tabId));
  return { window, row: windows[window]?.rows.findIndex((r) => r.tabId === tabId) ?? -1 };
}

// ---- replay

interface StepRecord {
  event: CoreEvent;
  before: Model;
  after: Model;
  effects: readonly Effect[];
}

function replay(start: Model, live: LiveFacts, events: readonly Ev[]): StepRecord[] {
  const ctx: Ctx = { model: start, live, last: null };
  return events.map((ev) => {
    const event = ev(ctx);
    const before = ctx.model;
    const { model: after, effects } = step(before, event);
    ctx.model = after;
    ctx.last = after.interaction?.id ?? ctx.last;
    return { event, before, after, effects };
  });
}

// ---- invariants (04-state-machine 8), asserted after every step of every row

// The interaction that ended in this step, if any: live before, gone or replaced after.
const endedIn = ({ before, after }: StepRecord): Interaction | null =>
  before.interaction && after.interaction?.id !== before.interaction.id ? before.interaction : null;

const launchOf = (e: Effect): string | null => (e.kind === 'mountOverlay' || e.kind === 'openPopup' ? e.attempt : null);
const interactionOf = (attempt: string) => attempt.slice(0, attempt.lastIndexOf(':'));

function checkInvariants(trace: readonly StepRecord[], start: Model, live: LiveFacts, events: readonly Ev[]): void {
  const closes = new Map<string, number>(); // attempt -> closeHost count
  const frozen = new Map<string, Pick<Interaction, 'snapshot' | 'binding' | 'look' | 'quickTap'>>();
  const pressAt = new Map<string, number>();
  const activates = new Map<string, number>();
  const ended = new Set<string>();

  for (const rec of trace) {
    const { event, before, after, effects } = rec;
    const label = `${event.kind} at ${String(event.at)}`;
    for (const e of effects) {
      const a = launchOf(e);
      if (a) closes.set(a, 0);
      if (e.kind === 'closeHost') closes.set(e.attempt, (closes.get(e.attempt) ?? 0) + 1);
    }
    // 1: one interaction, at most one active host attempt
    const live1 = [...closes.values()].filter((n) => n === 0).length;
    expect(live1, `inv 1 open attempts after ${label}`).toBeLessThanOrEqual(1);

    const i = after.interaction;
    if (i) {
      if (!pressAt.has(i.id)) pressAt.set(i.id, event.at);
      // 2: snapshot, binding, look and quickTap never change after the press
      const seen = frozen.get(i.id);
      const now = { snapshot: i.snapshot, binding: i.binding, look: i.look, quickTap: i.quickTap };
      if (seen) expect(now, `inv 2 after ${label}`).toStrictEqual(seen);
      else frozen.set(i.id, now);
      // 7: a ready host or an exit by the press plus 500 ms
      const pending = i.state === 'overlayPending' || i.state === 'popupPending';
      if (pending) expect(event.at, `inv 7 after ${label}`).toBeLessThan((pressAt.get(i.id) ?? 0) + 500);
    }

    // 3: each attempt closed at most once; an interaction that ends has every attempt closed exactly once
    for (const [a, n] of closes) expect(n, `inv 3 closes of ${a} after ${label}`).toBeLessThanOrEqual(1);
    const exited = endedIn(rec);
    if (exited) {
      ended.add(exited.id);
      for (const [a, n] of closes) if (interactionOf(a) === exited.id) expect(n, `inv 3 ${a} at exit`).toBe(1);
      // 5: every due still live at the event was cancelled
      for (const timer of ['dwell', 'hostDeadline', 'idle'] as const) {
        const due = exited.due[timer];
        if (due !== null && due > event.at) {
          expect(effects, `inv 5 ${timer} at ${label}`).toContainEqual({ kind: 'cancelTimer', id: exited.id, timer });
        }
      }
    }
    for (const e of effects) {
      if (e.kind === 'startTimer') expect(ended.has(e.id), `inv 5 timer after exit at ${label}`).toBe(false);
    }

    // 4: activate at most once per interaction, only with a commit exit in the same step
    const acts = effects.filter((e) => e.kind === 'activate');
    if (acts.length > 0) {
      expect(acts, `inv 4 at ${label}`).toHaveLength(1);
      expect(exited ? effects : [], `inv 4 commit at ${label}`).toContainEqual({
        kind: 'closeHost',
        attempt: exited?.attempt.id,
        outcome: 'commit',
      });
      const id = exited?.id ?? '';
      activates.set(id, (activates.get(id) ?? 0) + 1);
      expect(activates.get(id), `inv 4 per interaction`).toBe(1);
      // 9: a pointer commit names a snapshot row
      if (event.kind === 'host' && event.input.kind === 'pick' && exited) {
        const { window, row } = event.input.row;
        const w = exited.snapshot.windows[window];
        expect(acts[0], `inv 9 at ${label}`).toMatchObject({
          target: { tabId: w?.rows[row]?.tabId, windowId: w?.windowId },
        });
      }
    }

    // 8: host input and status naming another attempt act as a bare timer event (T-51)
    if ((event.kind === 'host' || event.kind === 'hostStatus') && event.attempt !== before.interaction?.attempt.id) {
      const bare = step(before, { kind: 'timer', at: event.at, id: 'none', timer: 'idle' });
      expect({ model: after, effects }, `inv 8 at ${label}`).toStrictEqual(bare);
    }
  }

  // 6: the same events with the same at values produce the same effects
  expect(
    replay(start, live, events).map((s) => s.effects),
    'inv 6',
  ).toStrictEqual(trace.map((s) => s.effects));
}

// ---- outcome of the last event

export type State = 'idle' | 'overlayPending' | 'popupPending' | 'ready' | 'holding' | 'holding.open' | 'search';

export interface Outcome {
  state: State;
  exit: 'commit' | 'cancel' | null; // the exit the last event took
  activate: { tab: TabId; focusWindow: boolean } | null; // the switch it asked for
  shown?: TabId | undefined; // the highlighted tab of the latest visible frame
  closed?: TabId | null; // the tab the last event closed with the close key
  restored?: string | null; // the session the last event reopened (T-78)
  host?: 'overlay' | 'popup' | undefined; // the live interaction's host attempt
}

export const switchTo = (tab: TabId, focusWindow = false) => ({ tab, focusWindow });

const stateOf = (i: Interaction | null): State =>
  !i ? 'idle' : i.state === 'holding' && i.open ? 'holding.open' : i.state;

function shownOf(trace: readonly StepRecord[]): TabId | undefined {
  const i = trace.at(-1)?.after.interaction;
  if (!i) return undefined;
  const frames = trace.flatMap((s) => s.effects).filter((e) => e.kind === 'render' && e.attempt === i.attempt.id);
  const last = frames.at(-1);
  if (last?.kind !== 'render') return undefined;
  const f = last.frame;
  const ref = f.mode === 'search' ? f.results[f.highlight] : f;
  return ref && i.snapshot.windows[ref.window]?.rows[ref.row]?.tabId;
}

export interface Row {
  name: string;
  settings?: Partial<Settings>;
  live?: LiveFacts;
  events: readonly Ev[]; // prior events, then the next event
  expect: Partial<Outcome> & Pick<Outcome, 'state'>;
}

// Replays a row from the fixture, asserts the invariants after every step, and checks the last event's outcome.
export function check(row: Row): void {
  const live = row.live ?? LIVE.two;
  const start = base(row.settings ?? {}, live);
  const trace = replay(start, live, row.events);
  checkInvariants(trace, start, live, row.events);
  const last = trace.at(-1);
  if (!last) throw new Error('a row needs events');
  const ended = endedIn(last);
  const close = last.effects.find((e) => e.kind === 'closeHost' && e.attempt === ended?.attempt.id);
  const act = last.effects.find((e) => e.kind === 'activate');
  const closed = last.effects.find((e) => e.kind === 'closeTab');
  const restored = last.effects.find((e) => e.kind === 'restoreTab');
  const outcome: Outcome = {
    state: stateOf(last.after.interaction),
    exit: close?.kind === 'closeHost' ? close.outcome : null,
    activate: act?.kind === 'activate' ? switchTo(act.target.tabId, act.focusWindow) : null,
    ...('shown' in row.expect ? { shown: shownOf(trace) } : {}),
    ...('closed' in row.expect ? { closed: closed?.kind === 'closeTab' ? closed.tabId : null } : {}),
    ...('restored' in row.expect ? { restored: restored?.kind === 'restoreTab' ? restored.sessionId : null } : {}),
    ...('host' in row.expect ? { host: last.after.interaction?.attempt.host } : {}),
  };
  expect(outcome).toStrictEqual({ exit: null, activate: null, ...row.expect });
}
