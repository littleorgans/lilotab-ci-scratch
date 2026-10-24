// One step's working state and the helpers every row shares: ids, recents updates, timers, frames and the exits.

import type { Frame, StartView } from '../protocol/index.ts';
import { rank } from '../ranking/index.ts';
import { project, record, sameEnvelope, type Recents } from '../recents/index.ts';
import { candidates, copyText, iconKeys, listView, rowOf } from '../snapshot/index.ts';
import { diagnostic, hasRow, sameRow, type Cursor, type Millis, type RequestId, type RowRef } from '../types.ts';
import { HOLD_IDLE_MS, SEARCH_IDLE_MS, type Effect, type Interaction, type Model, type TimerKind } from './types.ts';

// Mutable only inside one step; step returns its final values.
export interface Run {
  model: Model;
  effects: Effect[];
}

export function emit(run: Run, ...effects: Effect[]): void {
  run.effects.push(...effects);
}

export function nextId(run: Run): string {
  const counter = run.model.counter + 1;
  run.model = { ...run.model, counter };
  return `${run.model.boot}:${String(counter)}`;
}

export function setInteraction(run: Run, i: Interaction | null): void {
  run.model = { ...run.model, interaction: i };
}

// One checkpoint per change to the projected envelope (03 5.4); clear always answers its request (T-50).
export function setRecents(run: Run, next: Recents, reply: RequestId | null = null): void {
  const prev = run.model.recents;
  run.model = { ...run.model, recents: next };
  if (next === prev && reply === null) return;
  const envelope = project(next);
  if (reply !== null || !sameEnvelope(project(prev), envelope)) emit(run, { kind: 'checkpoint', envelope, reply });
}

export const TIMER_KINDS: readonly TimerKind[] = ['dwell', 'hostDeadline', 'idle'];

export function startTimer(run: Run, i: Interaction, timer: TimerKind, due: Millis): Interaction {
  emit(run, { kind: 'startTimer', id: i.id, timer, due });
  return { ...i, due: { ...i.due, [timer]: due } };
}

export function cancelTimer(run: Run, i: Interaction, timer: TimerKind): Interaction {
  if (i.due[timer] === null) return i;
  emit(run, { kind: 'cancelTimer', id: i.id, timer });
  return { ...i, due: { ...i.due, [timer]: null } };
}

export const isGone = (i: Pick<Interaction, 'gone'>, ref: RowRef): boolean => hasRow(i.gone, ref);

// copy is the highlighted row's, and none while the hold list is hidden: a quick tap puts no address in the page
// (C-SRCH-26, C-HOLD-20).
export function frameOf(i: Interaction, visible: boolean): Frame {
  if (i.search) {
    const target = i.search.results[i.search.highlight];
    return { mode: 'search', ...i.search, copy: target ? copyText(i.snapshot, target) : null };
  }
  const { cursor } = i;
  const copy = visible ? copyText(i.snapshot, cursor) : null;
  return { mode: 'hold', visible, open: i.open, window: cursor.window, row: cursor.row, gone: i.gone, copy };
}

export const startView = (i: Interaction): StartView => ({
  mode: i.search ? 'search' : 'hold',
  binding: i.binding,
  quickTap: i.quickTap,
  look: i.look,
  view: listView(i.snapshot),
  frame: frameOf(i, false),
});

// Publish a live change: start or restart idle with the mode's length, 5 min for search and the open list (04 4.1,
// T-68), replace the interaction, then render its visible frame when paint asks. Rows that only restart idle (T-26,
// T-40, T-42, T-61, T-66) pass paint false; so does T-25, except that with history stepping on it ends it and redraws
// once, an identical frame (D9).
export function publish(run: Run, i: Interaction, at: Millis, paint: boolean): void {
  const next = startTimer(run, i, 'idle', at + (i.search || i.open ? SEARCH_IDLE_MS : HOLD_IDLE_MS));
  setInteraction(run, next);
  if (paint) emit(run, { kind: 'render', attempt: next.attempt.id, frame: frameOf(next, true) });
}

export function loadIcons(run: Run, i: Interaction): void {
  emit(run, { kind: 'loadIcons', attempt: i.attempt.id, keys: iconKeys(i.snapshot) });
}

export const wrap = (n: number, delta: number, length: number): number => (((n + delta) % length) + length) % length;

// The first of at + delta, at + 2 delta, ... around a ring of length that passes ok; at itself when none does.
export function seek(at: number, delta: number, length: number, ok: (n: number) => boolean): number {
  for (let k = 1; k <= length; k++) {
    const n = wrap(at, delta * k, length);
    if (ok(n)) return n;
  }
  return at;
}

// Search over every listed row not gone, highlighting the given row when it is a result (T-18, T-31, T-55, T-75,
// C-SRCH-08).
export function searchOf(i: Pick<Interaction, 'snapshot' | 'gone'>, query: string, highlight: Cursor | null) {
  const results = rank(
    query,
    candidates(i.snapshot).filter((c) => !isGone(i, c.ref)),
  );
  return { query, results, highlight: Math.max(0, highlight ? results.findIndex((r) => sameRow(r, highlight)) : 0) };
}

// ---- exits (04 4.3): cancel every live due, close the host once, clear the slot, in one step

function close(run: Run, i: Interaction, outcome: 'commit' | 'cancel'): void {
  let next = i;
  for (const timer of TIMER_KINDS) next = cancelTimer(run, next, timer);
  emit(run, { kind: 'closeHost', attempt: i.attempt.id, outcome });
  setInteraction(run, null);
}

// T-49
export function cancel(run: Run, i: Interaction): void {
  close(run, i, 'cancel');
}

// T-47: the source tab switches nothing. T-59: closed or moved meanwhile, nothing switches. T-48: activate and record.
// T-78: a recently closed row reopens, with no activation and no recents write.
export function commit(run: Run, i: Interaction, target: RowRef): void {
  close(run, i, 'commit');
  if (isGone(i, target)) return;
  const named = rowOf(i.snapshot, target);
  if (named?.closed) {
    emit(run, { kind: 'restoreTab', sessionId: named.row.sessionId });
    return;
  }
  if (!named || named.row.tabId === i.source.tabId) return;
  const { window: w, row } = named;
  if (run.model.recents.tabs.get(row.tabId)?.windowId !== w.windowId) return;
  const op = nextId(run);
  const tab = { tabId: row.tabId, windowId: w.windowId };
  const focusWindow = w.windowId !== i.source.windowId;
  emit(run, { kind: 'activate', op, target: tab, focusWindow });
  const { recents, overflow } = record(run.model.recents, op, tab, focusWindow);
  if (overflow) emit(run, { kind: 'diagnostic', entry: diagnostic('pendingOverflow') });
  setRecents(run, recents);
}
