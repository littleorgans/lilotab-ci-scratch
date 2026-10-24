// Interaction state machine: one keyboard interaction from command to exit (03-components 3.1, 04-state-machine).
// init and step are the core entry (03 4.2); the worker shell is their only caller.

import {
  clear,
  readEnvelope,
  reconcile,
  settle,
  tabActivated,
  tabAttached,
  tabGone,
  tabReplaced,
  windowCreated,
  windowFocused,
  windowRemoved,
  type Recents,
} from '../recents/index.ts';
import { readSettings, storeSettings, type SettingsRead } from '../settings/index.ts';
import { diagnostic, type BootId, type LiveFacts, type Millis } from '../types.ts';
import { TIMER_KINDS, emit, setInteraction, setRecents, type Run } from './run.ts';
import { onBrowser, onExpiry, onInput, onPress, onStatus } from './rows.ts';
import type { CoreEvent, Model, Step, TimerKind } from './types.ts';

export * from './types.ts';

function reportSettings(run: Run, read: SettingsRead): void {
  for (const { field, cause } of read.issues) {
    emit(run, { kind: 'diagnostic', entry: diagnostic('settingsIssue', `${field}:${cause}`) });
  }
}

// The booted event in function form. A rejected or late read arrives as undefined (the shell logs it); live null:
// the boot query failed, so recents stay as hydrated with no active tabs until the next press (06 2.4).
export function init(boot: BootId, stored: unknown, settings: unknown, live: LiveFacts | null): Step {
  const envelope = readEnvelope(stored);
  const read = readSettings(settings);
  const run: Run = {
    model: { boot, recents: envelope.recents, settings: read.settings, interaction: null, counter: 0 },
    effects: [],
  };
  if (envelope.fault) emit(run, { kind: 'diagnostic', entry: diagnostic('envelopeDiscarded', envelope.fault) });
  reportSettings(run, read);
  if (read.source === 'migrated') emit(run, { kind: 'saveSettings', settings: storeSettings(read.settings) });
  if (live) setRecents(run, reconcile(envelope.recents, live)); // C-REC-09
  emit(run, { kind: 'showBadge', on: read.settings.tabCountBadge === 'on' }); // C-SET-27
  return { model: run.model, effects: run.effects };
}

// Every live due at or before at expires first, earliest first, each through its own row (04 3).
function expire(run: Run, at: Millis): void {
  for (;;) {
    const i = run.model.interaction;
    if (!i) return;
    let timer: TimerKind | null = null;
    for (const kind of TIMER_KINDS) {
      const due = i.due[kind];
      if (due !== null && due <= at && (timer === null || due < (i.due[timer] ?? Infinity))) timer = kind;
    }
    if (timer === null) return;
    const due = i.due[timer] ?? at;
    const next = { ...i, due: { ...i.due, [timer]: null } };
    setInteraction(run, next);
    onExpiry(run, next, timer, due);
  }
}

// Recents first: every tab and window event updates recents before its interaction row (04 4.1).
const RECENTS: { [K in CoreEvent['kind']]?: (r: Recents, e: Extract<CoreEvent, { kind: K }>) => Recents } = {
  tabActivated: (r, e) => tabActivated(r, e.tabId, e.windowId),
  windowFocused: (r, e) => windowFocused(r, e.windowId),
  windowCreated: (r, e) => windowCreated(r, e.windowId, e.normal),
  tabRemoved: (r, e) => tabGone(r, e.tabId, e.windowId),
  tabDetached: (r, e) => tabGone(r, e.tabId, e.windowId),
  tabAttached: (r, e) => tabAttached(r, e.tabId, e.windowId),
  tabReplaced: (r, e) => tabReplaced(r, e.added, e.removed),
  windowRemoved: (r, e) => windowRemoved(r, e.windowId),
  activated: (r, e) => settle(r, e.op, e.result), // T-60, T-64, T-65
};

function handle(run: Run, e: CoreEvent): void {
  const update = RECENTS[e.kind] as ((r: Recents, e: CoreEvent) => Recents) | undefined;
  if (update) setRecents(run, update(run.model.recents, e));
  const i = run.model.interaction;
  switch (e.kind) {
    case 'command':
    case 'toolbarClicked':
    case 'searchCommand':
      onPress(run, e);
      break;
    case 'hostStatus':
      if (i?.attempt.id === e.attempt) onStatus(run, i, e.status, e.at); // else T-51
      break;
    case 'host':
      if (i?.attempt.id === e.attempt) onInput(run, i, e.input, e.at); // else T-51
      break;
    case 'tabActivated':
    case 'tabRemoved':
    case 'tabDetached':
    case 'tabReplaced':
    case 'windowRemoved':
    case 'windowFocused':
      if (i) onBrowser(run, i, e);
      break;
    case 'clearData': // T-50: a live snapshot is kept
      setRecents(run, clear(run.model.recents, e.live), e.request);
      break;
    case 'settingsChanged': {
      // T-53: from the next interaction; a live one keeps its binding, look, snapshot and dues
      const read = readSettings(e.settings);
      reportSettings(run, read);
      const badge = read.settings.tabCountBadge;
      if (badge !== run.model.settings.tabCountBadge) emit(run, { kind: 'showBadge', on: badge === 'on' }); // C-SET-27
      run.model = { ...run.model, settings: read.settings };
      break;
    }
    default: // windowCreated, tabAttached, activated: recents only; timer: T-52, expiry is decided by time
      break;
  }
}

export function step(model: Model, event: CoreEvent): Step {
  const run: Run = { model, effects: [] };
  expire(run, event.at);
  handle(run, event);
  return { model: run.model, effects: run.effects };
}
