// Gesture timing log, measurement builds only (`just build-timing`): the record shape and its storage.local keys,
// shared by the worker, which writes records, and the options page, which reads, exports and clears them. Release
// builds record nothing (C-SET-14): its two roots test the build mode inline, `import.meta.env.MODE === 'timing'`,
// which the bundler folds before it splits chunks, so this module drops out too. A flag imported from here would
// fold only after chunking and leave this module in a shared chunk. Records hold no URL, title or tab content.

import type { DeclineReason, HostInput } from '../core/index.ts';

export const TIMING_KEY = 'timingLog'; // JSON TimingRecord[], oldest first; the worker is its only writer
export const TIMING_OFF_KEY = 'timingOff'; // true while the options page has recording off; absent means on
export const TIMING_MAX = 500; // bound serialization so a new press cannot wait behind a large storage write

export type PageClass = 'http' | 'newtab' | 'internal' | 'webstore' | 'pdf' | 'file' | 'other';
export type InputClass = 'release' | 'key' | 'pointer' | 'other';
export type EndReason =
  | 'quickTap' // release before the list showed (T-16)
  | 'release' // T-27
  | 'inferredRelease' // unheld input after a missed release (C-HOLD-12, T-28)
  | 'enter'
  | 'pick'
  | 'key' // the cancel causes the host sends (T-20, T-29, T-43)
  | 'blur'
  | 'hidden'
  | 'pageLeave'
  | 'deadline' // HOST_DEADLINE_MS with no ready host (T-11, T-62)
  | 'idle' // T-32, T-46
  | 'newPress' // T-05, T-55
  | 'focusLoss' // T-33, T-56
  | 'sourceLeft' // T-20, T-33
  | 'hostClosed' // T-30, T-44
  | 'hostFailed' // T-12, T-58
  | 'other';

// Times are ms after the press, one decimal; null when the step never happened.
export interface AttemptTimes {
  host: 'overlay' | 'popup';
  start: number; // the worker initiated the injection or the popup opening
  launched: number | null; // executeScript or openPopup settled
  ready: number | null; // `ready` received
  declined: { reason: DeclineReason | 'failed'; at: number } | null; // an overlay that fell back (T-08)
}

export interface GestureRecord {
  epoch: number; // the press, ms since 1970
  entry: 'shortcut' | 'search'; // search: the toolbar icon or the Search tabs command; 'toolbar' in old logs
  holdDelayMs: number;
  quickTap: 'flip' | 'list';
  page: PageClass;
  tabs: number;
  windows: number;
  workerAge: number; // ms since the worker started, at the press
  firstOfBoot: boolean; // the first gesture since the worker started
  gateWaited: boolean; // the press arrived before the init gate settled
  prepared: number | null; // the press's preparation settled
  stepped: number; // the press stepped: host chosen
  attempts: AttemptTimes[]; // [0] the chosen host; [1] the popup after a declined or failed overlay
  dwellDue: number | null; // no dwell with Open tab list or a search entry
  dwell: number | null; // the worker expired the dwell
  shown: number | null; // the worker sent the visible list
  input: { at: number; kind: InputClass; input: HostInput['kind']; inferred: boolean } | null; // first host input
  presses: number; // further shortcut presses during the gesture
  pressAt: number | null; // the first of them
  unheardPress?: boolean; // a further press while the list was already shown with no host input; absent in old logs
  deadline: number | null; // the host deadline fired with the host still pending
  outcome: 'commit' | 'cancel';
  switched: boolean; // a commit that activated another tab
  reason: EndReason;
  end: number;
}

// A timed out preparation never reaches the core, so no host, settings or live tab facts are claimed.
export interface DroppedPressRecord {
  epoch: number;
  entry: GestureRecord['entry'];
  workerAge: number;
  firstOfBoot: boolean;
  gateWaited: boolean;
  prepared: number;
  outcome: 'dropped';
  reason: 'prepTimeout';
  end: number;
}

export type TimingRecord = GestureRecord | DroppedPressRecord;

export interface TimingState {
  on: boolean;
  records: TimingRecord[];
}

// Written only by this extension, so the shape is trusted; anything else reads as empty.
export async function readTiming(): Promise<TimingState> {
  const stored = await chrome.storage.local.get([TIMING_KEY, TIMING_OFF_KEY]);
  let records: unknown = stored[TIMING_KEY];
  if (typeof records === 'string') {
    try {
      records = JSON.parse(records);
    } catch {
      records = [];
    }
  }
  return {
    on: stored[TIMING_OFF_KEY] !== true,
    records: Array.isArray(records) ? (records as TimingRecord[]).slice(-TIMING_MAX) : [],
  };
}

export function onTimingChanged(listener: (change: { cleared: boolean; on?: boolean }) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const log = changes[TIMING_KEY];
    const off = changes[TIMING_OFF_KEY];
    if (!log && !off) return;
    listener({
      cleared: log !== undefined && log.newValue === undefined,
      ...(off ? { on: off.newValue !== true } : {}),
    });
  });
}
