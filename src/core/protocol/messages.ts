// Message shapes between worker and hosts and the options page, and the limits producers and parsers share (05-events 4.9).

import type { Settings } from '../settings/index.ts';
import type { Millis, RowRef } from '../types.ts';

export const PROTOCOL = 1;

export const TITLE_MAX = 500; // ListRow.title, UTF-16 code units
export const SITE_MAX = 253; // ListRow.site, UTF-16 code units
export const ICON_MAX = 16_384; // IconSrc, the whole data URL
export const QUERY_MAX = 256; // the search field's maxlength; HostInput query and Frame query
export const URL_MAX = 8192; // CopyText.url, UTF-16 code units; a longer address gives copy null (C-SRCH-26)
export const PAGE_MAX = 500; // HostInput page rows, the whole rows the list shows (K-32)
export const PING_MS = 20_000; // search ping while visible and focused (K-17, C-SRCH-22)
export const CLEAR_ANSWER_MS = 5_000; // the options page reads silence past this as not cleared (C-DATA-09)

// Parsed from commands.getAll at each press (C-KEY-03): the primary modifier, the exact modifiers and Chrome's key token.
export interface Binding {
  held: 'meta' | 'ctrl' | 'alt';
  mods: { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean };
  key: string; // 'E', '7', 'Comma', 'Up', ...
}

// Frozen with the snapshot for C-SET-12; values come from the settings schema.
export type Look = Pick<Settings, 'theme' | 'reduceMotion' | 'textSize'>;

export type IconSrc = string; // 'data:image/png;base64,' then base64, at most ICON_MAX characters

export interface ListRow {
  title: string; // '' renders site, else "Untitled" (C-HOLD-17)
  site: string;
  pinned: boolean;
  audible: boolean; // C-HOLD-25
  icon: IconSrc | null;
}
export interface ListView {
  windows: readonly { current: number; rows: readonly ListRow[] }[]; // [0] is the source window
  closed: readonly ListRow[]; // recently closed rows, only ever search results (C-SRCH-27)
}

// The highlighted row's text for the copy keys (C-SRCH-26): title cut to TITLE_MAX, the full address.
export interface CopyText {
  title: string;
  url: string;
}

// copy: the highlighted row's, null while the hold list is hidden or when the address passes URL_MAX.
export type Frame =
  // open: the open list (T-68); gone: rows closed with the close key, hidden (C-HOLD-14)
  | {
      mode: 'hold';
      visible: boolean;
      open: boolean;
      window: number;
      row: number;
      gone: readonly RowRef[];
      copy: CopyText | null;
    }
  // the host never writes query into the field; results omit gone rows
  | { mode: 'search'; query: string; results: readonly RowRef[]; highlight: number; copy: CopyText | null };
// A RowRef whose window is view.windows.length names view.closed[row], the closed window: accepted in search results,
// pick and icon patches; rejected in a hold frame and gone (05 4.9).

export type HostMode = 'hold' | 'search';

export interface StartView {
  mode: HostMode;
  binding: Binding | null; // null only in search mode from the toolbar (C-POP-09)
  quickTap: Settings['quickTap']; // frozen at the press (C-SET-12, C-SET-19)
  look: Look;
  view: ListView;
  frame: Frame;
}

export interface IconPatch {
  w: number;
  r: number;
  src: IconSrc;
}

export type CancelCause = 'key' | 'blur' | 'hidden' | 'pageLeave';

export type HostInput =
  | { kind: 'release'; inferred: boolean } // inferred: unheld input after a missed release (C-HOLD-12)
  | { kind: 'step'; delta: 1 | -1 } // held letter in hold: All windows walks the global stack until an arrow (D6)
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'window'; delta: 1 | -1 }
  | { kind: 'latchSearch' }
  | { kind: 'leaveSearch' } // held F in search: back to hold (T-67)
  | { kind: 'query'; text: string }
  | { kind: 'enter' }
  | { kind: 'pick'; row: RowRef } // click on a search result row (C-SRCH-17)
  | { kind: 'ping' }
  | { kind: 'activity' } // restarts idle only
  | { kind: 'jump'; to: 'first' | 'last' } // Home, End in search (K-31)
  | { kind: 'page'; delta: 1 | -1; rows: number } // Page Down, Page Up in search; rows 1 to PAGE_MAX (K-32)
  | { kind: 'close' } // the close key on the highlighted row (K-33)
  | { kind: 'cancel'; cause: CancelCause };

export type DeclineReason = 'unfocused' | 'frameFocus' | 'pdf' | 'unsupported';

export type HostToWorker = { t: 'ready' } | { t: 'declined'; reason: DeclineReason } | { t: 'input'; input: HostInput };

// No close message: the worker's port.disconnect() is the close (05 4.4).
export type WorkerToHost =
  | { t: 'start'; start: StartView; wake: Millis | null } // wake: ms to the dwell due at posting (05 2.3)
  | { t: 'frame'; frame: Frame }
  | { t: 'icons'; icons: readonly IconPatch[] };

export interface OptionsRequest {
  v: typeof PROTOCOL;
  t: 'clear';
}
export interface OptionsReply {
  v: typeof PROTOCOL;
  t: 'cleared';
  ok: boolean;
}

export type ChannelPhase = 'opening' | 'open' | 'done';

// At most max code units, never ending in half a surrogate pair.
export function fitText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const ICON_PREFIX = 'data:image/png;base64,';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// raw itself when it is a valid IconSrc, else null: the placeholder (C-ICON-03).
export function iconSrc(raw: string | null): IconSrc | null {
  if (raw === null || raw.length > ICON_MAX || !raw.startsWith(ICON_PREFIX)) return null;
  return BASE64.test(raw.slice(ICON_PREFIX.length)) ? raw : null;
}
