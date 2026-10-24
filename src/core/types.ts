// Ids and browser facts every core module shares (03-components 4.2, 4.3).

export type Millis = number; // monotonic within one worker boot (05-events 2.2)
export type TabId = number;
export type WindowId = number;
export type BootId = string; // random per worker evaluation; no ':' or '|'
export type InteractionId = string; // `${BootId}:${counter}`
export type AttemptId = string; // `${InteractionId}:${n}`
export type OpId = string; // `${BootId}:${counter}`, one per activate effect
export type RequestId = number; // the clear request's ingress seq, assigned by the worker

export interface TabRef {
  tabId: TabId;
  windowId: WindowId;
}

// Names one snapshot row for the whole interaction; hosts address rows only this way (03 4.6).
export interface Cursor {
  window: number;
  row: number;
}
export type RowRef = Cursor;

export const sameRow = (a: RowRef, b: RowRef): boolean => a.window === b.window && a.row === b.row;
export const hasRow = (rows: readonly RowRef[], ref: RowRef): boolean => rows.some((r) => sameRow(r, ref));

export interface SourceTab {
  tabId: TabId;
  windowId: WindowId;
  url: string;
}

// Normal windows in browser order, never a private one: the adapter guard drops those (C-PRIV-08).
export interface LiveFacts {
  windows: readonly { windowId: WindowId; tabs: readonly LiveTab[] }[];
}
export interface LiveTab {
  tabId: TabId;
  title: string;
  url: string;
  pinned: boolean;
  audible: boolean; // read once at the press (C-HOLD-25)
  active: boolean;
  iconKey: string | null;
}

// One sessions.getRecentlyClosed tab entry, read at the press (C-SRCH-27); never a private tab (C-PRIV-08).
export interface ClosedTab {
  sessionId: string;
  title: string;
  url: string;
  iconKey: string | null;
}

// Developer builds log these; release builds drop them (C-SET-14). detail names a cause, field or kind, never a value.
export type DiagnosticCode =
  | 'envelopeDiscarded'
  | 'envelopeReadFailed'
  | 'settingsReadFailed'
  | 'settingsIssue'
  | 'liveFactsFailed'
  | 'prepFailed'
  | 'prepTimeout'
  | 'pendingOverflow'
  | 'sessionSaveFailed'
  | 'settingsSaveFailed'
  | 'hostDeclined'
  | 'protocolViolation'
  | 'portRefused';

export interface Diagnostic {
  code: DiagnosticCode;
  detail: string | null;
}

export const diagnostic = (code: DiagnosticCode, detail: string | null = null): Diagnostic => ({ code, detail });
