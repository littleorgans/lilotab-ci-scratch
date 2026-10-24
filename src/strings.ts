// English user facing strings: the product's one catalogue, so locales can follow (01-overview). Pure data, read by
// the manifest, the hosts and the pages. One export per surface: bundles drop unused exports, never unused properties,
// so the overlay carries no settings text (C-PERF-02).

import { bugs, description, displayName as NAME, homepage } from '../package.json';
import type { SettingField, SettingGroup, Settings } from './core/index.ts';

// Label, value names, optional unit and optional hint per stored setting, typed against the core SCHEMA so a missing name fails the
// build (C-SET).
export const SETTING_TEXT: {
  readonly [K in SettingField]: {
    label: string;
    values: Readonly<Record<`${Settings[K]}`, string>>;
    unit?: string;
    hint?: string;
  };
} = {
  quickTap: { label: 'Quick tap', values: { flip: 'Flip to last tab', list: 'Open tab list' } },
  quickScope: { label: 'Quick tap switches within', values: { window: 'This window', all: 'All windows' } },
  holdDelayMs: { label: 'Hold delay', values: { 0: '0', 50: '50', 100: '100', 200: '200' }, unit: 'ms' },
  tabOrder: { label: 'Tab order', values: { recent: 'Recent', window: 'Window order' } },
  listSurface: { label: 'Show the list', values: { overlay: 'Over the page', popup: 'In a popup' } },
  closedTabs: {
    label: 'Include recently closed tabs',
    values: { off: 'Off', on: 'On' },
    hint: 'Search also finds tabs you closed recently. Chrome asks for permission first.', // C-SET-29
  },
  tabCountBadge: {
    label: 'Tab count badge',
    values: { off: 'Off', on: 'On' },
    hint: 'Shows how many tabs are open on the toolbar icon.', // C-SET-27
  },
  theme: { label: 'Theme', values: { dark: 'Dark', light: 'Light', system: 'Match system' } },
  textSize: { label: 'Text size', values: { default: 'Default', large: 'Large' } },
  reduceMotion: { label: 'Reduce motion', values: { system: 'Match system', always: 'Always', never: 'Never' } },
};

// Held key names, as the contract writes them (C-KEY-03).
export const KEY_NAMES = { meta: 'Cmd', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' } as const;

export const PRODUCT = NAME; // package.json is the one home of the product name

// The switch command's description on the shortcuts page.
export const COMMAND_TEXT = 'Switch to the last used tab; hold for the tab list';
export const SEARCH_COMMAND_TEXT = 'Search all your tabs'; // C-KEY-12

// The list view, in both hosts.
export const LIST_TEXT = {
  untitled: 'Untitled', // C-HOLD-17
  noResults: 'No matching tabs', // C-SRCH-16
  search: 'Search tabs', // C-SRCH-02, the field's name and placeholder
  tabs: 'Tabs', // the listbox name (C-A11Y-01)
  windows: 'Windows', // the strip's tab list name (C-A11Y-01)
  thisWindow: 'This window', // the source window (C-SRCH-07)
  window: (n: number) => `Window ${String(n)}`,
  pinned: 'Pinned', // C-A11Y-02
  audible: 'Playing sound', // C-HOLD-25, named right after the title (C-A11Y-02)
  rowName: (parts: readonly string[]) => parts.join(', '), // title, sound, pinned state, window (C-A11Y-02)
  notCopied: 'Could not copy', // C-SRCH-26
  closed: 'Recently closed', // a recently closed row's accessible name (C-SRCH-27)
} as const;

// The shortcut rows, on the settings page and the welcome tab.
export const SHORTCUT_TEXT = {
  switchLabel: 'Switch tabs', // C-SET-01
  searchLabel: 'Search tabs', // C-SET-20
  none: 'No shortcut set', // C-KEY-09
  taken: 'Your browser or another extension may already use the default. Choose a shortcut with Change shortcut.', // C-KEY-09
  // C-KEY-13: macOS only, since a page cannot reliably tell Opera or Vivaldi apart from Chrome.
  macForks:
    'In Opera and Vivaldi, Command+E opens a browser feature. If the shortcut does nothing there, choose another one, such as Control+S, with Change shortcut.',
  noModifier: 'This shortcut needs Cmd, Ctrl or Alt', // C-KEY-11
  change: 'Change shortcut', // C-SET-01, C-SET-17
  where: 'set on chrome://extensions/shortcuts',
} as const;

export const OPTIONS_TEXT = {
  title: `${NAME} settings`,
  // The group labels, in the side index and above the cards (C-SET intro).
  groups: {
    shortcuts: 'Shortcuts',
    quickTap: 'Quick tap',
    tabList: 'Tab list',
    search: 'Search',
    toolbar: 'Toolbar icon',
    appearance: 'Appearance',
    privacy: 'Privacy and data',
    about: 'About',
  } satisfies Record<SettingGroup, string>,
  index: 'Settings groups', // the side index's name
  newer: `These settings were saved by a newer version of ${NAME}. Update ${NAME} to change them.`, // C-DATA-10
  saveFailed: 'Could not save the setting. Try again.', // C-SET-18
  device: 'This device only', // C-SET-24
  deviceKept: `Settings and recent tab history stay in this browser. ${NAME} sends nothing anywhere.`,
  private: 'Private windows', // C-SET-24
  privateNever: `${NAME} never runs in private windows.`,
  history: 'Recent tab history', // C-SET-10
  historyKept: `Kept until the browser closes or ${NAME} updates.`, // C-SET-10 (06 5.3)
  clear: 'Clear now',
  clearing: 'Clearing', // 06 5.3
  cleared: 'Recent tab history cleared.', // C-DATA-09
  notCleared: 'Recent tab history was not cleared. Try again.', // C-DATA-09
  defaults: 'Settings', // the Restore defaults row label (C-SET-11)
  restore: 'Restore defaults', // C-SET-11
  restoreScope: 'Sets every setting on this page to its default. Shortcuts and recent tab history stay.',
  flipOnly: 'The two settings below apply to Flip to last tab only.', // shown when Quick tap is Open tab list
} as const;

// The fixed list keys, with this platform's modifier names; held is the bound shortcut's held key (C-SET-21,
// C-KEY-03). chord is the close key's modifiers, Ctrl+Cmd or Ctrl+Alt (C-SRCH-25).
export const KEYS_TEXT = {
  label: 'Keys in the list',
  hint: (held: string) => `Fixed keys. Hold ${held} while the list shows, or use them in search.`,
  keys: (mod: string, chord: string): readonly (readonly [keys: string, action: string])[] => [
    ['Shortcut again, Down', 'Next tab'],
    ["Shift with the shortcut's letter, Up", 'Previous tab'],
    ['Left, Right', 'Other windows'],
    ['F', 'Search'],
    ['Release', 'Switch to the highlighted tab'],
    ['Esc, Backspace', 'Close the list'],
    ['Home, End', 'First or last result (search)'],
    ['Page Up, Page Down', 'Move by a page (search)'],
    ['Enter', 'Switch (search, open list)'],
    ['Esc', 'Clear the search, then close'],
    [`${chord}+W`, 'Close the tab'], // C-SRCH-25
    [`${mod}+C, ${chord}+C`, 'Copy the address'], // C-SRCH-26
    [`Shift+${mod}+C, Shift+${chord}+C`, 'Copy the title and address'],
  ],
} as const;

// About, from package.json (C-SET-28).
export const ABOUT_TEXT = {
  description,
  version: (v: string) => `Version ${v}`,
  welcome: 'Welcome tab',
  showWelcome: 'Show welcome tab',
  source: 'Source code',
  sourceUrl: homepage,
  sourceLink: homepage.replace(/^https:\/\//, ''),
  report: 'Report a problem',
  reportUrl: bugs.url,
  reportLink: 'Open an issue',
} as const;

export const WELCOME_TEXT = {
  title: `Welcome to ${NAME}`,
  tap: (shortcut: string) => `Press ${shortcut} to switch to your last used tab.`,
  hold: (held: string, shortcut: string) =>
    `Keep holding ${held} to see your tabs. Press ${shortcut} again or use the arrow keys to move, then release to switch.`,
  toolbar: `Click the ${NAME} toolbar icon to search all your tabs.`, // C-POP-09
  settings: 'Settings',
} as const;
