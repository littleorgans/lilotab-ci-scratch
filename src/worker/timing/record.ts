// Gesture timing log, measurement builds only: one GestureRecord per gesture, assembled from what the worker shell
// already sees, each step's model before and after with its event and effects, plus the preparation, launch and
// decline times around them. It only observes: no event, effect or order changes. Callers pass every time.

import type {
  AttemptTimes,
  EndReason,
  GestureRecord,
  InputClass,
  PageClass,
  TimingRecord,
} from '../../browser/timing.ts';
import {
  expiry,
  isWebStore,
  urlParts,
  type AttemptId,
  type CoreEvent,
  type DeclineReason,
  type Effect,
  type Expiry,
  type HostInput,
  type Interaction,
  type Millis,
  type Model,
  type Step,
  type TimerKind,
} from '../../core/index.ts';

type Press = Extract<CoreEvent, { kind: 'command' | 'toolbarClicked' | 'searchCommand' }>;
type CloseHost = Extract<Effect, { kind: 'closeHost' }>;
type Pending = Omit<GestureRecord, 'outcome' | 'switched' | 'reason' | 'end'>;

interface Open {
  id: string; // the interaction
  at: Millis; // its press
  record: Pending;
  attempts: Map<AttemptId, AttemptTimes>;
  declines: Map<AttemptId, DeclineReason>;
}

export interface GestureLog {
  gate(at: Millis): void;
  prepared(event: CoreEvent | null, at: Millis): void;
  dropped(entry: GestureRecord['entry'], pressAt: Millis, at: Millis): void;
  launched(attempt: AttemptId, at: Millis): void;
  declined(attempt: AttemptId, reason: DeclineReason): void;
  stepped(before: Model, event: CoreEvent, after: Step, at: Millis): void;
  live(): boolean;
  drop(): void; // forget the live gesture: recording turned off
}

const INTERNAL = ['chrome', 'chrome-extension', 'chrome-untrusted', 'devtools', 'about', 'view-source'];

// A coarse class only; the address itself never leaves this function.
export function pageClass(url: string): PageClass {
  const parts = urlParts(url);
  const { scheme, host, path } = parts;
  if ((scheme === 'chrome' && (host === 'newtab' || host === 'new-tab-page')) || scheme === 'chrome-search') {
    return 'newtab';
  }
  if (isWebStore(parts)) return 'webstore';
  if (path.toLowerCase().endsWith('.pdf')) return 'pdf';
  if (scheme === 'http' || scheme === 'https') return 'http';
  if (scheme === 'file') return 'file';
  return INTERNAL.includes(scheme) ? 'internal' : 'other';
}

const INPUT_CLASS: Readonly<Record<HostInput['kind'], InputClass>> = {
  release: 'release',
  step: 'key',
  move: 'key',
  window: 'key',
  latchSearch: 'key',
  leaveSearch: 'key',
  query: 'key',
  enter: 'key',
  pick: 'pointer',
  ping: 'other',
  activity: 'other',
  jump: 'key',
  page: 'key',
  close: 'key',
  cancel: 'other',
};

const tenth = (ms: number): number => Math.round(ms * 10) / 10;
const isPress = (e: CoreEvent): e is Press =>
  e.kind === 'command' || e.kind === 'toolbarClicked' || e.kind === 'searchCommand';

// The timer whose expiry row ended the gesture; dwell never does (T-13, T-14).
const TIMER_END: Readonly<Record<TimerKind, EndReason>> = { dwell: 'other', hostDeadline: 'deadline', idle: 'idle' };

// seen is the interaction the event's row saw, after expiry.
function inputReason(seen: Interaction, input: HostInput): EndReason {
  switch (input.kind) {
    case 'release':
      if (seen.state === 'ready') return 'quickTap';
      return input.inferred ? 'inferredRelease' : 'release';
    case 'cancel':
      return input.cause;
    case 'enter':
    case 'pick':
      return input.kind;
    default:
      return 'other';
  }
}

// The event that ended the gesture, when no timer did.
function reasonOf(seen: Interaction, event: CoreEvent): EndReason {
  switch (event.kind) {
    case 'host':
      return inputReason(seen, event.input);
    case 'hostStatus':
      return event.status === 'closed' ? 'hostClosed' : 'hostFailed';
    case 'command':
    case 'toolbarClicked':
    case 'searchCommand':
      return 'newPress';
    case 'windowFocused':
      return 'focusLoss';
    case 'tabActivated':
    case 'tabRemoved':
    case 'tabDetached':
    case 'tabReplaced':
    case 'windowRemoved':
      return 'sourceLeft';
    default:
      return 'other';
  }
}

// origin: the epoch of Millis 0, performance.timeOrigin in the worker.
export function createGestureLog(origin: number, done: (record: TimingRecord) => void): GestureLog {
  let open: Open | null = null;
  let gateAt: Millis | null = null;
  let gestures = 0;
  const preparedAt = new WeakMap<CoreEvent, Millis>();

  function addAttempt(g: Open, attempt: AttemptId, host: AttemptTimes['host'], start: number): void {
    const times: AttemptTimes = { host, start, launched: null, ready: null, declined: null };
    g.attempts.set(attempt, times);
    g.record.attempts.push(times);
  }

  function begin(i: Interaction, e: Press, before: Model, at: Millis): Open {
    const prepared = preparedAt.get(e);
    const g: Open = {
      id: i.id,
      at: e.at,
      attempts: new Map(),
      declines: new Map(),
      record: {
        epoch: Math.round(origin + e.at),
        entry: i.entry,
        holdDelayMs: before.settings.holdDelayMs,
        quickTap: i.quickTap,
        page: pageClass(e.source.url),
        tabs: e.live.windows.reduce((n, w) => n + w.tabs.length, 0),
        windows: e.live.windows.length,
        workerAge: Math.round(e.at),
        firstOfBoot: gestures === 0,
        gateWaited: gateAt === null || e.at < gateAt,
        prepared: prepared === undefined ? null : tenth(prepared - e.at),
        stepped: tenth(at - e.at),
        attempts: [],
        dwellDue: i.due.dwell === null ? null : tenth(i.due.dwell - e.at),
        dwell: null,
        shown: null,
        input: null,
        presses: 0,
        pressAt: null,
        unheardPress: false,
        deadline: null,
      },
    };
    addAttempt(g, i.attempt.id, i.attempt.host, g.record.stepped);
    gestures += 1;
    return g;
  }

  // One step of the live gesture g; prev is its interaction before the step, cur the slot after it, and the core's
  // expiry phase (04 3) gives seen, the slot the event's row saw, and the timers fired before it.
  function observe(
    g: Open,
    prev: Interaction,
    cur: Interaction | null,
    event: CoreEvent,
    step: Step,
    at: Millis,
    { interaction: seen, fired }: Expiry,
  ) {
    const r = g.record;
    const off = (t: Millis) => tenth(t - g.at);
    const ended = seen ? undefined : fired.at(-1); // an expiry row ended the gesture
    if (fired.includes('dwell')) r.dwell ??= off(at);
    if (ended === 'hostDeadline') r.deadline = off(at);
    if (event.kind === 'hostStatus') {
      const a = g.attempts.get(event.attempt);
      if (a && event.status === 'ready') a.ready ??= off(event.at);
      else if (a?.host === 'overlay' && (event.status === 'declined' || event.status === 'failed')) {
        a.declined ??= { reason: g.declines.get(event.attempt) ?? 'failed', at: off(event.at) };
      }
    } else if (
      event.kind === 'host' &&
      event.attempt === prev.attempt.id &&
      event.input.kind !== 'ping' &&
      seen !== null
    ) {
      const { input } = event;
      r.input ??= {
        at: off(event.at),
        kind: input.kind === 'cancel' && input.cause === 'key' ? 'key' : INPUT_CLASS[input.kind],
        input: input.kind,
        inferred: input.kind === 'release' && input.inferred,
      };
    } else if (event.kind === 'command' && cur?.id === prev.id) {
      if (r.shown !== null && r.input === null) r.unheardPress = true;
      r.presses += 1;
      r.pressAt ??= off(event.at);
    }
    for (const e of step.effects) {
      if (e.kind === 'openPopup' && !g.attempts.has(e.attempt)) addAttempt(g, e.attempt, 'popup', off(at));
      if (e.kind === 'render' && (e.frame.mode === 'search' || e.frame.visible)) r.shown ??= off(at);
    }
    if (cur?.id === prev.id) {
      if (cur.state === 'holding' || cur.state === 'search') r.shown ??= off(at); // a search entry shows at ready
      return;
    }
    const close = step.effects.find((e): e is CloseHost => e.kind === 'closeHost' && e.attempt === prev.attempt.id);
    done({
      ...r,
      outcome: close?.outcome ?? 'cancel',
      switched: step.effects.some((e) => e.kind === 'activate'),
      reason: ended ? TIMER_END[ended] : seen ? reasonOf(seen, event) : 'other',
      end: off(at),
    });
    open = null;
  }

  return {
    gate(at) {
      gateAt ??= at;
    },
    prepared(event, at) {
      if (event && isPress(event)) preparedAt.set(event, at);
    },
    dropped(entry, pressAt, at) {
      done({
        epoch: Math.round(origin + pressAt),
        entry,
        workerAge: Math.round(pressAt),
        firstOfBoot: gestures === 0,
        gateWaited: gateAt === null || pressAt < gateAt,
        prepared: tenth(at - pressAt),
        outcome: 'dropped',
        reason: 'prepTimeout',
        end: tenth(at - pressAt),
      });
      gestures += 1;
    },
    launched(attempt, at) {
      const a = open?.attempts.get(attempt);
      if (a && open) a.launched ??= tenth(at - open.at);
    },
    declined(attempt, reason) {
      open?.declines.set(attempt, reason);
    },
    stepped(before, event, after, at) {
      const prev = before.interaction;
      const cur = after.model.interaction;
      if (open && prev?.id !== open.id) open = null; // lost track, as after recording was off
      if (open && prev) observe(open, prev, cur, event, after, at, expiry(before, event.at));
      if (cur && cur.id !== prev?.id && isPress(event)) open = begin(cur, event, before, at);
    },
    live: () => open !== null,
    drop() {
      open = null;
    },
  };
}
