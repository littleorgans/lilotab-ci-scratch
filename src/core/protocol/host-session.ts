// Host mode reconciliation for one host session (03-components 4.12, 05-events 4.5): the host switches locally at
// once, and the worker acknowledges each switch with one opposite mode frame in channel order (T-18, T-31, T-67).
// The session adapter holds the value, performs the effects in order and owns the DOM, ping and sensors.

import { sameRow, type RowRef } from '../types.ts';
import type { CopyText, Frame, HostInput, HostMode, IconPatch, StartView } from './messages.ts';
import { parseWorkerToHost, shapeOf } from './parse.ts';

export interface HostSession {
  origin: HostMode; // the start view's mode: a list started in search has no hold to go back to (T-67, K-14)
  mode: HostMode; // desired: what the host shows and classifies against, switched locally at once (03 4.12)
  acked: HostMode; // the worker's mode as its last admitted frame states it
  pending: number; // local switches whose acknowledging frame has not arrived
  quiet: boolean; // a hold ending input was sent: hidden, and no frame paints (03 4.12)
  shape: readonly number[]; // rows per start view window, then the closed window's, for parsing (05 4.5)
  quickTap: StartView['quickTap']; // frozen at the press (C-SET-19)
  open: boolean; // the open list (T-68): latched locally or by a frame, never cleared; survives search
  visible: boolean; // shown by the last paint or local search latch; a return to hold keeps it shown (K-08, T-67)
  source: RowRef; // the source tab's row
  target: RowRef | null; // the last painted cursor or highlighted result; null for no search results
  copy: CopyText | null; // the last painted frame's, for the copy keys (K-34)
  ending: 'fade' | 'cut'; // how the list closes (03 4.12): a cut after a commit candidate on another tab
}

// The row a frame points at: the hold cursor, or the highlighted search result.
const targetOf = (frame: Frame): RowRef | null =>
  frame.mode === 'hold' ? { window: frame.window, row: frame.row } : (frame.results[frame.highlight] ?? null);

const isOpen = (frame: Frame) => frame.mode === 'hold' && frame.open;
const isVisible = (frame: Frame) => frame.mode === 'search' || frame.visible;

export const sessionOf = (start: StartView): HostSession => ({
  origin: start.mode,
  mode: start.mode,
  acked: start.mode,
  pending: 0,
  quiet: false,
  shape: shapeOf(start.view),
  quickTap: start.quickTap,
  open: isOpen(start.frame),
  visible: isVisible(start.frame),
  source: { window: 0, row: start.view.windows[0]?.current ?? 0 },
  target: targetOf(start.frame),
  copy: start.frame.copy,
  ending: 'fade',
});

const isSource = (s: HostSession, ref: RowRef | null) => ref !== null && sameRow(ref, s.source);

export type SessionInput = { kind: 'message'; raw: unknown } | { kind: 'send'; input: HostInput };

export type SessionEffect =
  | { kind: 'start'; start: StartView }
  | { kind: 'paint'; frame: Frame }
  | { kind: 'icons'; icons: readonly IconPatch[] }
  | { kind: 'latch' } // to search locally: field focus and ping
  | { kind: 'unlatch' } // back to hold locally (T-67, K-22)
  | { kind: 'open' } // the open list latched (T-68): list focus and ping
  | { kind: 'hide'; fade: boolean } // fade on a cancel or a source commit, cut on a switch (03 4.12, C-A11Y-04)
  | { kind: 'post'; input: HostInput }
  | { kind: 'end' }; // a message this host cannot admit ends its session (05 4.5)

export interface SessionStep {
  session: HostSession | null;
  effects: readonly SessionEffect[];
}

const other = (m: HostMode): HostMode => (m === 'hold' ? 'search' : 'hold');

// Admission (05 4.5). A frame of the acknowledged mode is stale while switches are pending; an opposite one
// acknowledges the oldest pending switch, or with none pending is a violation (TC-01). Nothing paints until every
// switch drains, including rapid toggles back to the same mode (TC-02), so a paint always carries mode.
function receive(s: HostSession | null, raw: unknown): SessionStep {
  const end: SessionStep = { session: s, effects: [{ kind: 'end' }] };
  const m = parseWorkerToHost(raw, s?.shape ?? null);
  if (m === null) return end;
  if (m.t === 'start') return s ? end : { session: sessionOf(m.start), effects: [{ kind: 'start', start: m.start }] };
  if (!s) return end;
  if (m.t === 'icons') return { session: s, effects: [{ kind: 'icons', icons: m.icons }] };
  const { frame } = m;
  let next = s;
  if (frame.mode === s.acked) {
    if (s.pending > 0) return { session: s, effects: [] }; // older than the latest local switch
  } else {
    if (s.pending === 0) return end; // the worker switched without the host
    next = { ...s, acked: frame.mode, pending: s.pending - 1 };
  }
  if (next.pending > 0 || next.quiet) return { session: next, effects: [] }; // pending 0 means acked equals mode
  const painted = { ...next, target: targetOf(frame), copy: frame.copy, visible: isVisible(frame) };
  const paint: SessionEffect = { kind: 'paint', frame };
  // An open frame latches a list the host missed, after a stale paint; a closed one never unlatches it (T-68).
  if (isOpen(frame) && !next.open) return { session: { ...painted, open: true }, effects: [paint, { kind: 'open' }] };
  return { session: painted, effects: [paint] };
}

// A local switch, and its focus, comes before its post so keys typed in the round trip land in the field; a hold
// ending input hides before its post (03 4.12). In search, release and cancel only post (C-SRCH-16, T-41). A
// latchSearch in search or a leaveSearch outside a hold started list switches nothing, as the worker renders nothing
// for them; the classifier never sends them (K-07, K-14, K-22). In Open tab list a hold release never hides: on the
// painted source it opens the list locally, an open list ignores it, and on another tab the worker's close follows
// (T-68, T-69, T-27). A commit candidate sets how the list closes: a cut on another tab, a fade on the source, which
// switches nothing (T-47); a cancel always fades (03 4.12).
function send(s: HostSession, input: HostInput): SessionStep {
  const post: SessionEffect = { kind: 'post', input };
  const toggle = (effect: 'latch' | 'unlatch'): SessionStep => ({
    session: { ...s, mode: other(s.mode), pending: s.pending + 1, visible: true },
    effects: [{ kind: effect }, post],
  });
  if (input.kind === 'latchSearch' && s.mode === 'hold') return toggle('latch');
  if (input.kind === 'leaveSearch' && s.mode === 'search' && s.origin === 'hold') return toggle('unlatch');
  if (s.mode === 'hold' && input.kind === 'release' && s.quickTap === 'list') {
    if (s.open) return { session: s, effects: [post] };
    if (!isSource(s, s.target)) return { session: { ...s, ending: 'cut' }, effects: [post] };
    return { session: { ...s, open: true }, effects: [{ kind: 'open' }, post] };
  }
  if (s.mode === 'hold' && (input.kind === 'release' || input.kind === 'cancel')) {
    const fade = input.kind === 'cancel' || isSource(s, s.target);
    return { session: { ...s, quiet: true, ending: fade ? 'fade' : 'cut' }, effects: [{ kind: 'hide', fade }, post] };
  }
  if ((s.mode === 'search' || s.open) && (input.kind === 'enter' || input.kind === 'pick')) {
    const row = input.kind === 'pick' ? input.row : s.target; // Enter with no search results commits nothing
    if (row) return { session: { ...s, ending: isSource(s, row) ? 'fade' : 'cut' }, effects: [post] };
  }
  if (input.kind === 'cancel') return { session: { ...s, ending: 'fade' }, effects: [post] };
  return { session: s, effects: [post] };
}

// session is null before start; nothing is sent before it.
export function sessionStep(s: HostSession | null, input: SessionInput): SessionStep {
  if (input.kind === 'message') return receive(s, input.raw);
  return s ? send(s, input.input) : { session: s, effects: [] };
}
