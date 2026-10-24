// Selection within one interaction: the hold cursor, search results and highlight, the close key target and the repair
// after a row goes (04-state-machine 5 Steps, C-HOLD-14). Interaction values in and out; no effects, the snapshot never
// changes. Neither the hold cursor nor a search result is ever a gone row.

import type { HostInput } from '../protocol/index.ts';
import { rank } from '../ranking/index.ts';
import { candidates, rowAt } from '../snapshot/index.ts';
import { hasRow, listsRows, sameRow, type Cursor, type RowRef, type TabId } from '../types.ts';
import type { Interaction, SearchState } from './types.ts';

const wrap = (n: number, delta: number, length: number): number => (((n + delta) % length) + length) % length;

// The first of at + delta, at + 2 delta, ... around a ring of length that passes ok; at itself when none does.
function seek(at: number, delta: number, length: number, ok: (n: number) => boolean): number {
  for (let k = 1; k <= length; k++) {
    const n = wrap(at, delta * k, length);
    if (ok(n)) return n;
  }
  return at;
}

// ---- search results

// Search over every listed row not gone, highlighting the given row when it is a result (T-18, T-31, T-55, T-75,
// C-SRCH-08).
export function searchOf(i: Pick<Interaction, 'snapshot' | 'gone'>, query: string, highlight: Cursor | null) {
  const results = rank(
    query,
    candidates(i.snapshot).filter((c) => !hasRow(i.gone, c.ref)),
  );
  return { query, results, highlight: Math.max(0, highlight ? results.findIndex((r) => sameRow(r, highlight)) : 0) };
}

// The highlighted result; none with no results (T-38, T-40, C-SRCH-26).
export const highlightOf = (search: SearchState): RowRef | undefined => search.results[search.highlight];

// ---- hold cursor: every move returns a new value except a window step that changes nothing (T-25)

// Whether a row of this window still shows: rows closed with the close key leave the hold list (C-HOLD-14).
const visible = (i: Interaction, window: number) => (row: number) => !hasRow(i.gone, { window, row });

// The source window's current row, which the close key never closes (C-SRCH-25).
const home = (i: Interaction): Cursor => ({ window: 0, row: i.snapshot.windows[0]?.current ?? 0 });

// Within the shown window in its visible order; an arrow here ends history stepping for the hold (D6).
const moveCursor = (i: Interaction, delta: number): Interaction => {
  const { window } = i.cursor;
  const rows = i.snapshot.windows[window]?.rows.length ?? 1;
  return { ...i, history: false, cursor: { window, row: seek(i.cursor.row, delta, rows, visible(i, window)) } };
};

// Shortcut presses: in history, one step along the global stack from the highlighted row, the shown window following
// (D1, D4); else as an arrow.
export const stepCursor = (i: Interaction, delta: number): Interaction => {
  const { stack } = i.snapshot;
  if (!i.history || !stack) return moveCursor(i, delta);
  const at = stack.findIndex((c) => sameRow(c, i.cursor));
  const shows = (n: number) => stack[n] !== undefined && !hasRow(i.gone, stack[n]);
  return { ...i, cursor: stack[seek(at, delta, stack.length, shows)] ?? i.cursor };
};

// Shown window steps past windows whose rows are all gone, row = its current row, else its first row not gone (T-24),
// ending history stepping (D6); with one window shown nothing moves (T-25, C-WIN-10).
function stepWindow(i: Interaction, delta: number): Interaction {
  const { windows } = i.snapshot;
  const window = seek(i.cursor.window, delta, windows.length, (w) => listsRows(windows, i.gone, w));
  if (window === i.cursor.window) return i.history ? { ...i, history: false } : i;
  const { current = 0, rows = [] } = windows[window] ?? {};
  const row = visible(i, window)(current) ? current : seek(current, 1, rows.length, visible(i, window));
  return { ...i, history: false, cursor: { window, row } };
}

type HoldMove = Extract<HostInput, { kind: 'step' | 'move' | 'window' }>;

export const holdMove = (i: Interaction, input: HoldMove): Interaction => {
  if (input.kind === 'step') return stepCursor(i, input.delta);
  return input.kind === 'move' ? moveCursor(i, input.delta) : stepWindow(i, input.delta);
};

// ---- search highlight: i itself with no results, else a new value (T-40, T-77)

// A press, or a step or move: highlight ±1, wrapping (T-36, T-37).
export const moveHighlight = (i: Interaction, delta: number): Interaction => {
  const { search } = i;
  if (!search?.results.length) return i;
  return { ...i, search: { ...search, highlight: wrap(search.highlight, delta, search.results.length) } };
};

type SearchMove = Extract<HostInput, { kind: 'step' | 'move' | 'jump' | 'page' }>;

// Step and move wrap (T-36); Home, End and the page keys clamp to the results without wrapping (T-77).
export function searchMove(i: Interaction, input: SearchMove): Interaction {
  if (input.kind === 'step' || input.kind === 'move') return moveHighlight(i, input.delta);
  const { search } = i;
  if (!search?.results.length) return i;
  const last = search.results.length - 1;
  const to = input.kind === 'page' ? search.highlight + input.delta * input.rows : input.to === 'first' ? 0 : last;
  return { ...i, search: { ...search, highlight: Math.max(0, Math.min(to, last)) } };
}

// Back to hold: the query goes and history stays (04 5 Steps); the highlighted tab stays when the shown window lists
// it, else the initial cursor, or the current tab once that row is gone (T-67).
export function unlatched(i: Interaction, search: SearchState): Interaction {
  const target = highlightOf(search);
  const cursor = target?.window === i.cursor.window ? target : i.snapshot.initial;
  return { ...i, search: null, cursor: hasRow(i.gone, cursor) ? home(i) : cursor };
}

// ---- the close key

// The highlighted row when it is an open tab other than the source and not gone (T-74, T-75); else null (T-76). A
// recently closed row has no rowAt, so it never closes and never goes (03 4.6).
export function closable(i: Interaction): { ref: RowRef; tabId: TabId } | null {
  const ref = i.search ? highlightOf(i.search) : i.cursor;
  const row = ref && !hasRow(i.gone, ref) ? rowAt(i.snapshot, ref) : undefined;
  return ref && row && row.tabId !== i.source.tabId ? { ref, tabId: row.tabId } : null;
}

// T-74: the next row of the shown window not gone, else the previous one, else window 0's current row.
function pastGone(i: Interaction): Interaction {
  const { window, row } = i.cursor;
  const shown = (i.snapshot.windows[window]?.rows ?? []).map((_, r) => r).filter(visible(i, window));
  const next = shown.find((r) => r > row) ?? shown.findLast((r) => r < row);
  return { ...i, cursor: next === undefined ? home(i) : { window, row: next } };
}

// T-75: rank again without gone rows, keeping the highlight index, or the last result.
function rerank(i: Interaction, search: SearchState): Interaction {
  const { query, results } = searchOf(i, search.query, null);
  return { ...i, search: { query, results, highlight: Math.max(0, Math.min(search.highlight, results.length - 1)) } };
}

// The only way a row goes: it leaves the list and the selection moves off it in the same value (T-74, T-75).
export function withGone(i: Interaction, ref: RowRef): Interaction {
  const next = { ...i, gone: [...i.gone, ref] };
  return next.search ? rerank(next, next.search) : pastGone(next);
}
