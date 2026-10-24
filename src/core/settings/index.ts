// Settings rules: schema, defaults, parse, migrate and derive effective values (06-data 4).

import { isCount, isOneOf, isRecord, type Fields } from '../guards.ts';
import type { SourceTab } from '../types.ts';
import { urlParts, type UrlParts } from '../url.ts';

// Effective values, always complete; no version (06 4.1). Ids from the C-SET table.
export interface Settings {
  quickTap: 'flip' | 'list'; // C-SET-19
  quickScope: 'window' | 'all'; // C-SET-03 "Quick tap switches within"
  holdDelayMs: 0 | 50 | 100 | 200; // C-SET-04
  tabOrder: 'recent' | 'window'; // C-SET-05
  listSurface: 'overlay' | 'popup'; // C-SET-02
  closedTabs: 'off' | 'on'; // C-SET-22
  tabCountBadge: 'off' | 'on'; // C-SET-23
  theme: 'dark' | 'light' | 'system'; // C-SET-06
  textSize: 'default' | 'large'; // C-SET-09
  reduceMotion: 'system' | 'always' | 'never'; // C-SET-08
}

export type SettingField = keyof Settings;

// The settings page groups, in page order (C-SET intro).
export const GROUPS = [
  'shortcuts',
  'quickTap',
  'tabList',
  'search',
  'toolbar',
  'appearance',
  'privacy',
  'about',
] as const;
export type SettingGroup = (typeof GROUPS)[number];

// One table drives parsing, the options page controls and their group; key order is the page order (06 4.1).
export const SCHEMA: {
  readonly [K in SettingField]: {
    values: readonly Settings[K][];
    default: Settings[K];
    section: SettingGroup;
  };
} = {
  quickTap: { values: ['flip', 'list'], default: 'flip', section: 'quickTap' },
  quickScope: { values: ['window', 'all'], default: 'window', section: 'quickTap' },
  holdDelayMs: { values: [0, 50, 100, 200], default: 50, section: 'quickTap' },
  tabOrder: { values: ['recent', 'window'], default: 'recent', section: 'tabList' },
  listSurface: { values: ['overlay', 'popup'], default: 'overlay', section: 'tabList' },
  closedTabs: { values: ['off', 'on'], default: 'off', section: 'search' },
  tabCountBadge: { values: ['off', 'on'], default: 'off', section: 'toolbar' },
  theme: { values: ['dark', 'light', 'system'], default: 'dark', section: 'appearance' },
  textSize: { values: ['default', 'large'], default: 'default', section: 'appearance' },
  reduceMotion: { values: ['system', 'always', 'never'], default: 'system', section: 'appearance' },
};

export const FIELDS = Object.keys(SCHEMA) as readonly SettingField[];

export const DEFAULTS: Settings = Object.fromEntries(FIELDS.map((f) => [f, SCHEMA[f].default])) as unknown as Settings;

// MIGRATIONS[n - 1] takes version n to n + 1: total, pure, never throws, never validates (06 4.4).
export type Migration = (raw: Fields) => Record<string, unknown>;
export const MIGRATIONS: readonly Migration[] = [];
export const SETTINGS_VERSION = MIGRATIONS.length + 1;

export const SETTINGS_KEY = 'settings'; // storage.local key (06 3)

// storage.local `settings`: version plus only the fields that differ from DEFAULTS (06 4.2).
export type StoredSettings = { version: number } & Partial<Settings>;

export type SettingsSource = 'absent' | 'current' | 'migrated' | 'newer' | 'unreadable';
export interface SettingsIssue {
  field: string;
  cause: 'invalid' | 'unknownField';
}
export interface SettingsRead {
  settings: Settings;
  source: SettingsSource;
  issues: readonly SettingsIssue[]; // field names only, never values
}

// One row per stored case of 06 4.3. A rejected or late read is the caller's: it runs on DEFAULTS and writes nothing.
export function readSettings(raw: unknown): SettingsRead {
  if (raw === undefined) return { settings: DEFAULTS, source: 'absent', issues: [] };
  if (!isRecord(raw) || !isCount(raw['version'], 1)) {
    return { settings: DEFAULTS, source: 'unreadable', issues: [{ field: 'version', cause: 'invalid' }] };
  }
  const version = raw['version'];
  if (version > SETTINGS_VERSION) return validate(raw, 'newer');
  if (version === SETTINGS_VERSION) return validate(raw, 'current');
  return validate(
    MIGRATIONS.slice(version - 1).reduce<Fields>((fields, m) => m(fields), raw),
    'migrated',
  );
}

// Strict equality against the schema, no coercion (C-DATA-07); unknown fields are reported except under 'newer' (06 4.5).
function validate(raw: Fields, source: 'current' | 'migrated' | 'newer'): SettingsRead {
  const issues: SettingsIssue[] = [];
  const settings: Record<string, unknown> = {};
  for (const field of FIELDS) {
    const { values, default: fallback } = SCHEMA[field];
    const value = raw[field];
    const valid = value !== undefined && isOneOf(value, values as readonly unknown[]);
    if (value !== undefined && !valid) issues.push({ field, cause: 'invalid' });
    settings[field] = valid ? value : fallback;
  }
  if (source !== 'newer') {
    for (const field of Object.keys(raw)) {
      if (field !== 'version' && !Object.hasOwn(SCHEMA, field)) issues.push({ field, cause: 'unknownField' });
    }
  }
  return { settings: settings as unknown as Settings, source, issues };
}

// Sparse, at SETTINGS_VERSION. Restore defaults (C-SET-11) is storeSettings(DEFAULTS).
export function storeSettings(s: Settings): StoredSettings {
  const stored: Record<string, unknown> = { version: SETTINGS_VERSION };
  for (const field of FIELDS) if (s[field] !== DEFAULTS[field]) stored[field] = s[field];
  return stored as StoredSettings;
}

// Older code never writes over newer data (C-DATA-06, C-DATA-10).
export const writable = (source: SettingsSource): boolean => source !== 'newer';

// The Chrome Web Store, where Chrome blocks extension scripts.
export const isWebStore = ({ host, path }: UrlParts): boolean =>
  host === 'chromewebstore.google.com' || (host === 'chrome.google.com' && path.startsWith('/webstore'));

// Pages the overlay cannot host go straight to the popup (C-POP-01); other refusals arrive as a decline or failure (T-08).
function canHostOverlay(url: string): boolean {
  const parts = urlParts(url);
  return ['http', 'https', 'file'].includes(parts.scheme) && !isWebStore(parts);
}

// Two answers; with the one tab check they keep T-02 to T-04 disjoint (03 4.8).
export function chooseHost(source: SourceTab, settings: Settings): 'overlay' | 'popup' {
  return settings.listSurface === 'overlay' && canHostOverlay(source.url) ? 'overlay' : 'popup';
}
