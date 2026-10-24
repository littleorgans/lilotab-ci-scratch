// Settings edit rules for the options page: what the controls show, which write to issue, where a rejected save
// returns (06-data 4.6, C-SET-18), and the sessions permission Include recently closed tabs holds (C-SET-29). The page
// holds the edit value, performs writes, reads and permission calls, and reports results and permission facts.
// Not re-exported from settings/index.ts: this file imports it, so the cycle could reach DEFAULTS before it exists.

import {
  DEFAULTS,
  SCHEMA,
  readSettings,
  storeSettings,
  writable,
  type SettingField,
  type SettingGroup,
  type Settings,
  type SettingsSource,
  type StoredSettings,
} from './index.ts';

export interface SettingsEdit {
  stored: Settings; // the last stored read; a rejected save returns here (C-SET-18)
  source: SettingsSource | null; // null until the first read: controls stay disabled
  edited: Settings; // stored, with this page's latest edit applied; the write basis
  latest: number; // id of the latest write this page issued
  status: 'none' | 'saveFailed';
  group: SettingGroup; // group of the latest write; a failed save says so under it (C-SET-18)
  sessions: boolean; // the last permission fact: readback or Chrome's answer (C-SET-29)
  asking: boolean; // this page's On click waits on Chrome; the next input clears it
}

export const IDLE_EDIT: SettingsEdit = {
  stored: DEFAULTS,
  source: null,
  edited: DEFAULTS,
  latest: 0,
  status: 'none',
  group: 'privacy',
  sessions: false,
  asking: false,
};

export type EditInput =
  | { kind: 'read'; raw: unknown } // first load, readback, or a storage change
  | { kind: 'edit'; patch: Partial<Settings>; group: SettingGroup } // one control, or DEFAULTS for Restore defaults (C-SET-11)
  | { kind: 'failed'; write: number } // that write rejected
  | { kind: 'sessions'; held: boolean } // permission readback at load and on every permission change
  | { kind: 'asked'; result: 'granted' | 'denied' | 'failed' }; // Chrome's answer to requestSessions; failed: rejected

export type EditEffect =
  | { kind: 'write'; write: number; stored: StoredSettings }
  | { kind: 'read' }
  | { kind: 'requestSessions' } // inside the click's user gesture: the page performs it synchronously
  | { kind: 'removeSessions' };

export interface EditStep {
  edit: SettingsEdit;
  effects: readonly EditEffect[];
}

// No write before the first read, and none over newer data (C-DATA-06, C-DATA-10).
export const canEdit = (e: SettingsEdit): boolean => e.source !== null && writable(e.source);

// What the controls show: closed tabs On only while the permission is held, or while this page asks for it
// (C-SET-29). Display only; writes keep a stored On.
export const shownOf = (e: SettingsEdit): Settings => ({
  ...e.edited,
  closedTabs: e.asking ? 'on' : e.sessions ? e.edited.closedTabs : 'off',
});

// Settings that only Flip to last tab reads: Open tab list leaves them inactive, keeping their values (C-SET-19).
export const FLIP_ONLY: readonly SettingField[] = ['quickScope', 'holdDelayMs'];
export const inactive = (s: Settings, f: SettingField): boolean => s.quickTap === 'list' && FLIP_ONLY.includes(f);

// The complete edited object, under a new write id.
function write(e: SettingsEdit, patch: Partial<Settings>, group: SettingGroup): EditStep {
  const edited = { ...e.edited, ...patch };
  const latest = e.latest + 1;
  return {
    edit: { ...e, edited, latest, group, status: 'none' },
    effects: [{ kind: 'write', write: latest, stored: storeSettings(edited) }],
  };
}

// One row per input. Every write is the complete edited object, so a later write supersedes an older one (06 4.6);
// a success is not an input: the storage change that follows carries the stored result. Every input repaints, so
// every input ends the On shown while asking.
export function editStep(prev: SettingsEdit, input: EditInput): EditStep {
  const e: SettingsEdit = { ...prev, asking: false };
  const same: EditStep = { edit: e, effects: [] };
  switch (input.kind) {
    case 'read': {
      // Every stored read replaces the controls in arrival order: last save wins across pages (06 4.3, 4.6).
      const { settings, source } = readSettings(input.raw);
      return { edit: { ...e, stored: settings, source, edited: settings }, effects: [] };
    }
    case 'edit': {
      if (!canEdit(e)) return same;
      // Closed tabs On asks for the permission first and edits only when granted (C-SET-29).
      if (input.patch.closedTabs === 'on')
        return { edit: { ...e, asking: true }, effects: [{ kind: 'requestSessions' }] };
      const next = write(e, input.patch, input.group);
      // Closed tabs Off, from its control or Restore defaults, gives the permission back (C-SET-29).
      return input.patch.closedTabs === 'off'
        ? { ...next, effects: [...next.effects, { kind: 'removeSessions' }] }
        : next;
    }
    case 'asked':
      if (input.result === 'failed') return same;
      if (input.result === 'denied') return { edit: { ...e, sessions: false }, effects: [] };
      return canEdit(e)
        ? write({ ...e, sessions: true }, { closedTabs: 'on' }, SCHEMA.closedTabs.section)
        : { edit: { ...e, sessions: true }, effects: [] };
    case 'sessions':
      return { edit: { ...e, sessions: input.held }, effects: [] };
    case 'failed':
      // Product decision: a superseded failure shows no message, since the later write carried its value. To always
      // show it, return { ...same, edit: { ...e, status: 'saveFailed' } } here instead.
      if (input.write !== e.latest) return same;
      // The latest write rejected: back to the last stored read, say so, read storage again, never retry (C-SET-18).
      return { edit: { ...e, edited: e.stored, status: 'saveFailed' }, effects: [{ kind: 'read' }] };
  }
}
