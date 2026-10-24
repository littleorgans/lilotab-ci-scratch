// Options page: one page with a side index and one card per group (C-SET-26); edits settings through the core
// settings rules (03-components 3.3).

import '../page.css';
import { loadSettings, onSettingsChanged, saveSettings } from '../../browser/settings.ts';
import {
  DEFAULTS,
  GROUPS,
  IDLE_EDIT,
  SCHEMA,
  canEdit,
  editStep,
  type EditInput,
  type SettingField,
  type SettingGroup,
  type Settings,
  type SettingsEdit,
} from '../../core/index.ts';
import { OPTIONS_TEXT as T, SHORTCUT_TEXT } from '../../strings.ts';
import { SEARCH_COMMAND, SWITCH_COMMAND } from '../../worker/names.ts';
import { el, group } from '../dom.ts';
import { shortcutBlock } from '../shortcut.ts';
import { aboutRows } from './about.ts';
import { keysRow } from './keys.ts';
import { privacyRows } from './privacy.ts';
import { renderRows, settingRows } from './rows.ts';
import { TIMING_HEADING, timingGroup } from './timing.ts';

// The settings edit value; every change goes through step, which renders and performs the core's effects.
let edit: SettingsEdit = IDLE_EDIT;
// The group of this page's latest edit: a failed save says so under that group's card (C-SET-18).
let editGroup: SettingGroup = 'privacy';
// Include recently closed tabs holds the optional sessions permission (C-SET-29, C-PERM-05).
const SESSIONS: chrome.permissions.Permissions = { permissions: ['sessions'] };
let granted = false;

const newer = el('p', { class: 'notice', hidden: '' }, [T.newer]);
const restore = el('button', { type: 'button' }, [T.restore]);
const saveStatus = new Map<SettingGroup, HTMLElement>();

// A projection of the edit value; disabled until the first read and over newer data (C-DATA-10). The closed tabs
// control shows On only while the permission is held (C-SET-29).
function render(e: SettingsEdit): void {
  document.documentElement.className = e.shown.theme; // the page follows Theme (C-SET-06)
  renderRows(granted ? e.shown : { ...e.shown, closedTabs: 'off' }, canEdit(e));
  restore.disabled = !canEdit(e);
  newer.hidden = e.source !== 'newer';
  for (const [g, status] of saveStatus) {
    status.textContent = e.status === 'saveFailed' && g === editGroup ? T.saveFailed : ''; // C-SET-18
  }
}

// One validated object, one write; the core decides rollback and readback for a rejected save (06 4.6, C-SET-18).
function step(input: EditInput): void {
  const next = editStep(edit, input);
  edit = next.edit;
  render(edit);
  for (const effect of next.effects) {
    if (effect.kind === 'write') {
      void saveSettings(effect.stored).catch(() => {
        step({ kind: 'failed', write: effect.write });
      });
    } else {
      read();
    }
  }
}

// The stored value through the core read rules (06 4.3); a failed read changes nothing.
function read(): void {
  void loadSettings().then(
    (raw) => {
      step({ kind: 'read', raw });
    },
    () => undefined,
  );
}

function readGranted(): void {
  void chrome.permissions.contains(SESSIONS).then(
    (held) => {
      granted = held;
      render(edit);
    },
    () => undefined,
  );
}

// One edit from a control or Restore defaults; closed tabs Off, either way, gives the permission back (C-SET-29).
function change(patch: Partial<Settings>, g: SettingGroup): void {
  if (!canEdit(edit)) return;
  editGroup = g;
  step({ kind: 'edit', patch });
  if (patch.closedTabs === 'off') void chrome.permissions.remove(SESSIONS).catch(() => undefined);
}

// Closed tabs On asks for the permission inside the click's user gesture and edits only when granted (C-SET-29).
function choose(field: SettingField, value: Settings[SettingField]): void {
  if (field === 'closedTabs' && value === 'on') {
    void chrome.permissions.request(SESSIONS).then(
      (ok) => {
        granted = ok;
        if (ok) change({ closedTabs: 'on' }, 'search');
        else render(edit);
      },
      () => {
        render(edit);
      },
    );
    return;
  }
  change({ [field]: value }, SCHEMA[field].section);
}

// Writes { version } (C-SET-11, 06 4.2).
restore.addEventListener('click', () => {
  change(DEFAULTS, 'privacy');
});

// Rows that are not stored settings, after each group's setting rows (C-SET intro).
const FIXED: Partial<Record<SettingGroup, () => Node[]>> = {
  shortcuts: () => [
    shortcutBlock({ command: SWITCH_COMMAND, label: SHORTCUT_TEXT.switchLabel, needsModifier: true, suggested: true }),
    shortcutBlock({
      command: SEARCH_COMMAND,
      label: SHORTCUT_TEXT.searchLabel,
      needsModifier: false,
      suggested: false,
    }),
    keysRow(),
  ],
  privacy: () => privacyRows(restore),
  about: aboutRows,
};

// The group's card with its save failure line under it; the anchor id is the group in kebab case (quick-tap).
function settingsGroup(g: SettingGroup): HTMLElement {
  const status = el('p', { class: 'status', role: 'status' });
  saveStatus.set(g, status);
  const id = g.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const section = group(T.groups[g], [...settingRows(g, choose), ...(FIXED[g]?.() ?? [])], id);
  section.append(status);
  return section;
}

const sections: readonly (readonly [label: string, node: HTMLElement])[] = [
  ...GROUPS.map((g) => [T.groups[g], settingsGroup(g)] as const),
  // Inline, so release builds drop it (src/browser/timing.ts).
  ...(import.meta.env.MODE === 'timing' ? [[TIMING_HEADING, timingGroup()] as const] : []),
];

document.title = T.title;
document.body.append(
  el('div', { class: 'layout' }, [
    el('h1', {}, [T.title]),
    el(
      'nav',
      { class: 'index', 'aria-label': T.index },
      sections.map(([label, node]) => el('a', { href: `#${node.id}` }, [label])),
    ),
    el('main', {}, [newer, ...sections.map(([, node]) => node)]),
  ]),
);

// Another options page, or this one, saved: refresh from the stored value; a removed key reads as absent (06 3).
onSettingsChanged((raw) => {
  step({ kind: 'read', raw });
});
chrome.permissions.onAdded.addListener(readGranted);
chrome.permissions.onRemoved.addListener(readGranted);
render(edit);
read();
readGranted();
