// Parsers for every boundary: exact shapes, values inside their enums and limits, or a rejection (05-events 4).

import { hasExactly, isIndex, isOneOf, isRecord, isText, type Fields } from '../guards.ts';
import { SCHEMA } from '../settings/index.ts';
import type { AttemptId, RowRef } from '../types.ts';
import { heldOf } from './binding.ts';
import { MODIFIERS } from './keys.ts';
import {
  PAGE_MAX,
  PROTOCOL,
  QUERY_MAX,
  SITE_MAX,
  TITLE_MAX,
  URL_MAX,
  iconSrc,
  type Binding,
  type ChannelPhase,
  type Frame,
  type HostInput,
  type HostToWorker,
  type IconPatch,
  type ListView,
  type OptionsReply,
  type OptionsRequest,
  type StartView,
  type WorkerToHost,
} from './messages.ts';

// ---- channel names and phases (05 4.1, 4.4)

const ATTEMPT = /^[A-Za-z0-9_-]+:\d+:\d+$/;

export const portName = (attempt: AttemptId): string => `${String(PROTOCOL)}|${attempt}`;

// null: another protocol version or a bad shape.
export function parsePortName(name: string): AttemptId | null {
  const bar = name.indexOf('|');
  const attempt = name.slice(bar + 1);
  return bar > 0 && name.slice(0, bar) === String(PROTOCOL) && ATTEMPT.test(attempt) ? attempt : null;
}

// The handshake rule: ready opens, an overlay may decline once, input only once open (05 4.4).
export function admit(host: 'overlay' | 'popup', phase: ChannelPhase, m: HostToWorker): ChannelPhase | 'violation' {
  if (phase === 'opening' && m.t === 'ready') return 'open';
  if (phase === 'opening' && m.t === 'declined' && host === 'overlay') return 'done';
  if (phase === 'open' && m.t === 'input') return 'open';
  return 'violation';
}

// ---- host to worker (05 4.6)

const DELTAS = [1, -1] as const;
const CAUSES = ['key', 'blur', 'hidden', 'pageLeave'] as const;
const REASONS = ['unfocused', 'frameFocus', 'pdf', 'unsupported'] as const;
const ENDS = ['first', 'last'] as const;
const BARE = ['latchSearch', 'leaveSearch', 'enter', 'ping', 'activity', 'close'] as const;

const isRowRef = (raw: unknown): raw is RowRef =>
  hasExactly(raw, ['window', 'row']) && isIndex(raw['window'], Infinity) && isIndex(raw['row'], Infinity);

function parseInput(raw: unknown): HostInput | null {
  if (!isRecord(raw)) return null;
  const kind = raw['kind'];
  if (isOneOf(kind, BARE)) return hasExactly(raw, ['kind']) ? { kind } : null;
  const field = (name: string): unknown => (hasExactly(raw, ['kind', name]) ? raw[name] : undefined);
  switch (kind) {
    case 'release': {
      const inferred = field('inferred');
      return typeof inferred === 'boolean' ? { kind, inferred } : null;
    }
    case 'step':
    case 'move':
    case 'window': {
      const delta = field('delta');
      return isOneOf(delta, DELTAS) ? { kind, delta } : null;
    }
    case 'query': {
      const text = field('text');
      return isText(text, QUERY_MAX) ? { kind, text } : null;
    }
    case 'jump': {
      const to = field('to');
      return isOneOf(to, ENDS) ? { kind, to } : null;
    }
    case 'page': {
      if (!hasExactly(raw, ['kind', 'delta', 'rows'])) return null;
      const { delta, rows } = raw;
      return isOneOf(delta, DELTAS) && isIndex(rows, PAGE_MAX + 1) && rows > 0 ? { kind, delta, rows } : null;
    }
    case 'pick': {
      const row = field('row');
      return isRowRef(row) ? { kind, row: { window: row.window, row: row.row } } : null;
    }
    case 'cancel': {
      const cause = field('cause');
      return isOneOf(cause, CAUSES) ? { kind, cause } : null;
    }
    default:
      return null;
  }
}

export function parseHostToWorker(raw: unknown): HostToWorker | null {
  if (hasExactly(raw, ['t'])) return raw['t'] === 'ready' ? { t: 'ready' } : null;
  if (hasExactly(raw, ['t', 'reason'])) {
    return raw['t'] === 'declined' && isOneOf(raw['reason'], REASONS) ? { t: 'declined', reason: raw['reason'] } : null;
  }
  if (hasExactly(raw, ['t', 'input']) && raw['t'] === 'input') {
    const input = parseInput(raw['input']);
    return input ? { t: 'input', input } : null;
  }
  return null;
}

// ---- worker to host (05 4.5)

function isBinding(raw: unknown): raw is Binding {
  if (!hasExactly(raw, ['held', 'mods', 'key'])) return false;
  const mods = raw['mods'];
  if (!hasExactly(mods, MODIFIERS) || !MODIFIERS.every((m) => typeof mods[m] === 'boolean')) return false;
  const held = heldOf(mods as Binding['mods']);
  return (
    held !== null &&
    raw['held'] === held &&
    typeof raw['key'] === 'string' &&
    raw['key'].length > 0 &&
    raw['key'].length <= 32
  );
}

const isLook = (raw: unknown): boolean =>
  hasExactly(raw, ['theme', 'reduceMotion', 'textSize']) &&
  isOneOf(raw['theme'], SCHEMA.theme.values) &&
  isOneOf(raw['reduceMotion'], SCHEMA.reduceMotion.values) &&
  isOneOf(raw['textSize'], SCHEMA.textSize.values);

const isRow = (raw: unknown): boolean =>
  hasExactly(raw, ['title', 'site', 'pinned', 'audible', 'icon']) &&
  isText(raw['title'], TITLE_MAX) &&
  isText(raw['site'], SITE_MAX) &&
  typeof raw['pinned'] === 'boolean' &&
  typeof raw['audible'] === 'boolean' &&
  (raw['icon'] === null || (typeof raw['icon'] === 'string' && iconSrc(raw['icon']) !== null));

const isWindowView = (raw: unknown): raw is Fields & { rows: unknown[]; current: number } =>
  hasExactly(raw, ['current', 'rows']) &&
  Array.isArray(raw['rows']) &&
  raw['rows'].length > 0 &&
  isIndex(raw['current'], raw['rows'].length) &&
  raw['rows'].every(isRow);

const isListView = (raw: unknown): raw is ListView =>
  hasExactly(raw, ['windows', 'closed']) &&
  Array.isArray(raw['windows']) &&
  raw['windows'].length > 0 &&
  raw['windows'].every(isWindowView) &&
  Array.isArray(raw['closed']) &&
  raw['closed'].every(isRow);

// Rows per start view window, then the closed window's rows: the last entry (05 4.5, 4.9).
export const shapeOf = (view: ListView): readonly number[] => [
  ...view.windows.map((w) => w.rows.length),
  view.closed.length,
];

const inShape = (ref: RowRef, shape: readonly number[]) => isIndex(ref.row, shape[ref.window] ?? 0);

const isRefs = (raw: unknown, shape: readonly number[]): raw is RowRef[] =>
  Array.isArray(raw) && raw.every((r) => isRowRef(r) && inShape(r, shape));

const isCopy = (raw: unknown): boolean =>
  raw === null || (hasExactly(raw, ['title', 'url']) && isText(raw['title'], TITLE_MAX) && isText(raw['url'], URL_MAX));

// Checked against its own mode (05 4.5); which mode a host admits is host-session.ts. Only search results may name
// the closed window.
function isFrame(raw: unknown, shape: readonly number[]): raw is Frame {
  if (!isRecord(raw)) return false;
  if (!isCopy(raw['copy'])) return false;
  if (raw['mode'] === 'hold') {
    const open = shape.slice(0, -1);
    return (
      hasExactly(raw, ['mode', 'visible', 'open', 'window', 'row', 'gone', 'copy']) &&
      typeof raw['visible'] === 'boolean' &&
      typeof raw['open'] === 'boolean' &&
      isIndex(raw['window'], open.length) &&
      isIndex(raw['row'], open[raw['window']] ?? 0) &&
      isRefs(raw['gone'], open)
    );
  }
  const results = raw['results'];
  return (
    raw['mode'] === 'search' &&
    hasExactly(raw, ['mode', 'query', 'results', 'highlight', 'copy']) &&
    isText(raw['query'], QUERY_MAX) &&
    isRefs(results, shape) &&
    (results.length === 0 ? raw['highlight'] === 0 : isIndex(raw['highlight'], results.length))
  );
}

function isStart(raw: unknown): raw is StartView {
  if (!hasExactly(raw, ['mode', 'binding', 'quickTap', 'look', 'view', 'frame'])) return false;
  const mode = raw['mode'];
  if (!isOneOf(mode, ['hold', 'search'] as const) || !isOneOf(raw['quickTap'], SCHEMA.quickTap.values)) return false;
  if (!isLook(raw['look']) || !isListView(raw['view'])) return false;
  const binding = raw['binding'];
  if (binding === null ? mode !== 'search' : !isBinding(binding)) return false;
  const frame = raw['frame'];
  return isFrame(frame, shapeOf(raw['view'])) && frame.mode === mode;
}

// null without a dwell, else at most the longest hold delay (05 4.5).
const WAKE_MAX = Math.max(...SCHEMA.holdDelayMs.values);
const isWake = (raw: unknown): raw is number | null =>
  raw === null || (typeof raw === 'number' && raw >= 0 && raw <= WAKE_MAX);

const isIconPatch = (raw: unknown, shape: readonly number[]): raw is IconPatch =>
  hasExactly(raw, ['w', 'r', 'src']) &&
  isIndex(raw['w'], shape.length) &&
  isIndex(raw['r'], shape[raw['w']] ?? 0) &&
  typeof raw['src'] === 'string' &&
  iconSrc(raw['src']) !== null;

// shape is null before start: only a start parses. After it, every frame and icon must fit the start view's
// shape (05 4.5); host-session.ts decides which frames the host admits.
export function parseWorkerToHost(raw: unknown, shape: readonly number[] | null): WorkerToHost | null {
  if (!isRecord(raw)) return null;
  if (shape === null) {
    return hasExactly(raw, ['t', 'start', 'wake']) &&
      raw['t'] === 'start' &&
      isStart(raw['start']) &&
      isWake(raw['wake'])
      ? { t: 'start', start: raw['start'], wake: raw['wake'] }
      : null;
  }
  if (hasExactly(raw, ['t', 'frame']) && raw['t'] === 'frame') {
    const frame = raw['frame'];
    return isFrame(frame, shape) ? { t: 'frame', frame } : null;
  }
  if (hasExactly(raw, ['t', 'icons']) && raw['t'] === 'icons') {
    const icons = raw['icons'];
    return Array.isArray(icons) && icons.every((i) => isIconPatch(i, shape)) ? { t: 'icons', icons } : null;
  }
  return null;
}

// ---- options page (05 4.7)

export const parseOptionsRequest = (raw: unknown): OptionsRequest | null =>
  hasExactly(raw, ['v', 't']) && raw['v'] === PROTOCOL && raw['t'] === 'clear' ? { v: PROTOCOL, t: 'clear' } : null;

// Only ok true reads as cleared; anything malformed reads as not cleared at the caller (C-DATA-09).
export const parseOptionsReply = (raw: unknown): OptionsReply | null =>
  hasExactly(raw, ['v', 't', 'ok']) && raw['v'] === PROTOCOL && raw['t'] === 'cleared' && typeof raw['ok'] === 'boolean'
    ? { v: PROTOCOL, t: 'cleared', ok: raw['ok'] }
    : null;
