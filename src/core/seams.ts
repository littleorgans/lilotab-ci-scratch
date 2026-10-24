// Adapter interfaces the worker shell composes, and the host surface (03-components 4.11). Types only.

import type { CoreEvent, TimerKind } from './interaction/index.ts';
import type { Frame, IconPatch, StartView, WorkerToHost } from './protocol/index.ts';
import type { SessionEnvelope } from './recents/index.ts';
import type { StoredSettings } from './settings/index.ts';
import type { AttemptId, InteractionId, LiveFacts, Millis, OpId, TabId, TabRef, WindowId } from './types.ts';

export interface Clock {
  now(): Millis;
}

// Ingress: takes seq and at synchronously, then prepares the event with that at; null steps nothing (05-events 2.4).
export type Sink = (prepare: (at: Millis) => CoreEvent | null | Promise<CoreEvent | null>) => void;

export interface TabsAdapter {
  liveFacts(): Promise<LiveFacts>;
  activate(op: OpId, target: TabRef, focusWindow: boolean): void; // result arrives as `activated`
  remove(tabId: TabId): void; // the close key (T-74, T-75); failure ignored, the later tabRemoved is the truth
  onEvent(sink: Sink): void; // registered synchronously at top level
}

export interface HostLink {
  mountOverlay(attempt: AttemptId, tabId: TabId, start: StartView, dwell: Millis | null): void;
  openPopup(attempt: AttemptId, tabId: TabId, windowId: WindowId, start: StartView): void;
  send(attempt: AttemptId, msg: WorkerToHost): void;
  close(attempt: AttemptId, outcome: 'commit' | 'cancel'): void; // retires the attempt whether or not it connected
  onEvent(sink: Sink): void; // hostStatus and host, each naming its attempt
}

// One attempt per call; the core saveQueue decides retries (06-data 5).
export interface SessionStore {
  load(): Promise<unknown>;
  write(e: SessionEnvelope): Promise<void>;
}

export interface SettingsStore {
  load(): Promise<unknown>;
  save(s: StoredSettings): Promise<void>;
  onChanged(sink: Sink): void;
}

export interface Timers {
  start(id: InteractionId, timer: TimerKind, due: Millis): void;
  cancel(id: InteractionId, timer: TimerKind): void;
}

export interface IconSource {
  cached(keys: readonly (string | null)[]): (string | null)[];
  load(keys: readonly (string | null)[]): Promise<(string | null)[]>;
}

// Host side: what the shared list view paints.
export interface HostSurface {
  start(s: StartView): void;
  update(frame: Frame): void;
  icons(i: readonly IconPatch[]): void;
  close(): Promise<void>; // settles once the list is gone, after any close fade (03 4.12)
}
