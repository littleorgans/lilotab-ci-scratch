// Events into the core, effects out, and the model the worker shell owns (03-components 4.2 to 4.4, 04-state-machine 2).

import type { Binding, Frame, HostInput, Look, StartView } from '../protocol/index.ts';
import type { ActivationResult, Recents, SessionEnvelope } from '../recents/index.ts';
import type { Settings, StoredSettings } from '../settings/index.ts';
import type { Snapshot } from '../snapshot/index.ts';
import type {
  AttemptId,
  BootId,
  ClosedTab,
  Cursor,
  Diagnostic,
  InteractionId,
  LiveFacts,
  Millis,
  OpId,
  RequestId,
  RowRef,
  SourceTab,
  TabId,
  TabRef,
  WindowId,
} from '../types.ts';

export const HOST_DEADLINE_MS = 500; // C-POP-05
export const PREP_BUDGET_MS = 250; // boot reads and each entry's preparation (05-events 2.4)
export const HOLD_IDLE_MS = 10_000; // C-HOLD-13
export const SEARCH_IDLE_MS = 300_000; // C-SRCH-22; the open list too (C-TAP-11)

export type TimerKind = 'dwell' | 'hostDeadline' | 'idle';

// ready, declined: the host's handshake. failed: the attempt could not launch, or an overlay channel ended or broke
// the protocol before its handshake. closed: a popup channel ended before its handshake, or any channel after it.
export type HostStatus = 'ready' | 'declined' | 'failed' | 'closed';

type Closed = readonly ClosedTab[]; // read at each press (C-SRCH-27)

export type CoreEvent =
  | { kind: 'command'; at: Millis; source: SourceTab; binding: Binding; live: LiveFacts; closed: Closed }
  | { kind: 'toolbarClicked'; at: Millis; source: SourceTab; binding: Binding | null; live: LiveFacts; closed: Closed }
  | { kind: 'searchCommand'; at: Millis; source: SourceTab; binding: Binding | null; live: LiveFacts; closed: Closed }
  | { kind: 'tabActivated'; at: Millis; tabId: TabId; windowId: WindowId }
  | { kind: 'windowCreated'; at: Millis; windowId: WindowId; normal: boolean }
  | { kind: 'windowFocused'; at: Millis; windowId: WindowId | null } // null: WINDOW_ID_NONE; the core classifies the rest
  | { kind: 'tabRemoved'; at: Millis; tabId: TabId; windowId: WindowId; windowClosing: boolean }
  | { kind: 'tabDetached'; at: Millis; tabId: TabId; windowId: WindowId }
  | { kind: 'tabAttached'; at: Millis; tabId: TabId; windowId: WindowId }
  | { kind: 'tabReplaced'; at: Millis; added: TabId; removed: TabId }
  | { kind: 'windowRemoved'; at: Millis; windowId: WindowId }
  | { kind: 'settingsChanged'; at: Millis; settings: unknown }
  | { kind: 'clearData'; at: Millis; live: LiveFacts; request: RequestId }
  | { kind: 'hostStatus'; at: Millis; attempt: AttemptId; status: HostStatus }
  | { kind: 'host'; at: Millis; attempt: AttemptId; input: HostInput }
  | { kind: 'activated'; at: Millis; op: OpId; target: TabRef; result: ActivationResult }
  | { kind: 'timer'; at: Millis; id: InteractionId; timer: TimerKind };

export type Effect =
  | { kind: 'startTimer'; id: InteractionId; timer: TimerKind; due: Millis }
  | { kind: 'cancelTimer'; id: InteractionId; timer: TimerKind }
  // dwell: its due, which the host link turns into the host's wake (05-events 2.3, 4.5); null without one
  | { kind: 'mountOverlay'; attempt: AttemptId; tabId: TabId; start: StartView; dwell: Millis | null }
  | { kind: 'openPopup'; attempt: AttemptId; tabId: TabId; windowId: WindowId; start: StartView }
  | { kind: 'render'; attempt: AttemptId; frame: Frame }
  | { kind: 'loadIcons'; attempt: AttemptId; keys: readonly (readonly (string | null)[])[] }
  | { kind: 'closeHost'; attempt: AttemptId; outcome: 'commit' | 'cancel' }
  | { kind: 'activate'; op: OpId; target: TabRef; focusWindow: boolean }
  | { kind: 'closeTab'; tabId: TabId } // the close key (T-74, T-75); failure ignored, the later tabRemoved is the truth
  | { kind: 'restoreTab'; sessionId: string } // commit on a recently closed row (T-78, C-SRCH-28)
  | { kind: 'checkpoint'; envelope: SessionEnvelope; reply: RequestId | null }
  | { kind: 'saveSettings'; settings: StoredSettings } // the one migration write back at boot (06 4.3)
  | { kind: 'showBadge'; on: boolean } // init and a Tab count badge change (C-SET-27)
  | { kind: 'diagnostic'; entry: Diagnostic };

export type InteractionState = 'overlayPending' | 'popupPending' | 'ready' | 'holding' | 'search';

export interface SearchState {
  query: string;
  results: readonly RowRef[];
  highlight: number;
}

export interface Interaction {
  id: InteractionId;
  entry: 'shortcut' | 'search'; // search: the toolbar icon or the Search tabs command (C-POP-09, C-KEY-12)
  source: TabRef;
  binding: Binding | null; // null only for search entry without a usable shortcut (C-POP-09)
  look: Look; // frozen at the press (C-SET-12)
  quickTap: Settings['quickTap']; // frozen at the press (C-SET-12, C-SET-19)
  snapshot: Snapshot; // frozen at the press (C-HOLD-14)
  state: InteractionState;
  attempt: { id: AttemptId; host: 'overlay' | 'popup' }; // the one active host attempt
  due: Readonly<Record<TimerKind, Millis | null>>; // absolute deadlines; null = not running
  away: boolean; // browser focus left while the popup opens (T-57)
  cursor: Cursor; // hold mode cursor; starts at snapshot.initial
  history: boolean; // steps walk snapshot.stack; the first arrow in a hold ends it (D6)
  search: SearchState | null;
  open: boolean; // holding.open, the open list (T-68); false at the press, survives a search latch
  gone: readonly RowRef[]; // rows closed with the close key (T-74, T-75, C-SRCH-25); never the snapshot
}

export interface Model {
  boot: BootId;
  recents: Recents;
  settings: Settings;
  interaction: Interaction | null; // one slot for the whole browser
  counter: number; // feeds interaction and operation ids
}

export interface Step {
  model: Model;
  effects: readonly Effect[];
}
