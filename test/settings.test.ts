// TB-07 settings.read (07-tests 2.1): stored settings to effective settings, and what the options page writes.

import { describe, expect, it } from 'vite-plus/test';
import {
  DEFAULTS,
  FIELDS,
  IDLE_EDIT,
  SCHEMA,
  editStep,
  inactive,
  readSettings,
  storeSettings,
  writable,
  type Settings,
} from '../src/core/index.ts';

describe('TB-07 settings.read', () => {
  it.each<{ name: string; raw: unknown; settings: Partial<Settings>; source: string; issues: string[] }>([
    {
      name: 'C-SET-02 to C-SET-09, C-SET-22 and C-SET-23 absent give the defaults',
      raw: undefined,
      settings: DEFAULTS,
      source: 'absent',
      issues: [],
    },
    {
      name: 'C-SET-05 C-SET-06 version 1 sparse reads its values',
      raw: { version: 1, tabOrder: 'window', theme: 'light' },
      settings: { ...DEFAULTS, tabOrder: 'window', theme: 'light' },
      source: 'current',
      issues: [],
    },
    {
      name: 'C-SET-19 a store from before Quick tap reads Flip to last tab',
      raw: { version: 1, quickScope: 'all' },
      settings: { quickTap: 'flip', quickScope: 'all' },
      source: 'current',
      issues: [],
    },
    {
      name: 'C-DATA-07 "100" reads as the default, no coercion',
      raw: { version: 1, holdDelayMs: '100' },
      settings: { holdDelayMs: 50 },
      source: 'current',
      issues: ['holdDelayMs'],
    },
    {
      name: "C-DATA-07 C-SET-19 quickTap 'tap' reads the default",
      raw: { version: 1, quickTap: 'tap' },
      settings: { quickTap: 'flip' },
      source: 'current',
      issues: ['quickTap'],
    },
    {
      name: 'C-DATA-06 an unknown field such as privateWindows from a development build is ignored (06-data 4.3)',
      raw: { version: 1, privateWindows: true, theme: 'light' },
      settings: { ...DEFAULTS, theme: 'light' },
      source: 'current',
      issues: ['privateWindows'],
    },
    {
      name: 'C-DATA-06 version 2 keeps the fields this version knows',
      raw: { version: 2, theme: 'light', futureField: 1 },
      settings: { ...DEFAULTS, theme: 'light' },
      source: 'newer',
      issues: [],
    },
    {
      name: 'C-DATA-06 version 0 is unreadable and gives the defaults',
      raw: { version: 0, theme: 'light' },
      settings: DEFAULTS,
      source: 'unreadable',
      issues: ['version'],
    },
  ])('$name', ({ raw, settings, source, issues }) => {
    const read = readSettings(raw);
    expect({ ...read, issues: read.issues.map((i) => i.field) }).toMatchObject({ settings, source, issues });
  });

  it('C-DATA-06 C-DATA-10 settings from a newer version are never written', () => {
    expect(writable(readSettings({ version: 2 }).source)).toBe(false);
  });

  // Hold delays once offered and now retired load as the 50 ms default.
  it.each([25, 150, 250, 400])('C-SET-04 C-DATA-07 a saved hold delay of %i ms loads as 50 ms', (holdDelayMs) => {
    const read = readSettings({ version: 1, holdDelayMs });
    expect({ holdDelayMs: read.settings.holdDelayMs, source: read.source }).toEqual({
      holdDelayMs: 50,
      source: 'current',
    });
  });

  it('C-DATA-06 every allowed choice round trips through the store', () => {
    const all = FIELDS.reduce<Partial<Settings>[]>(
      (acc, field) => acc.flatMap((s) => SCHEMA[field].values.map((v) => ({ ...s, [field]: v }))),
      [{}],
    ) as Settings[];
    for (const s of all) expect(readSettings(storeSettings(s))).toEqual({ settings: s, source: 'current', issues: [] });
  });

  it("C-SET-19 'list' is stored sparse, as the version and the choice alone", () => {
    expect(storeSettings({ ...DEFAULTS, quickTap: 'list' })).toEqual({ version: 1, quickTap: 'list' });
  });

  it('C-SET-11 Restore defaults writes the version alone, clearing Open tab list', () => {
    const edit = editStep(IDLE_EDIT, { kind: 'read', raw: { version: 1, quickTap: 'list' } }).edit;
    expect(editStep(edit, { kind: 'edit', patch: DEFAULTS }).effects).toMatchObject([
      { kind: 'write', stored: { version: 1 } },
    ]);
  });

  // Build spec 5 item 2: the rule the options page renders.
  it.each([
    { quickTap: 'flip', inactive: [] },
    { quickTap: 'list', inactive: ['quickScope', 'holdDelayMs'] },
  ] as const)('C-SET-19 with Quick tap $quickTap, the inactive settings are $inactive', ({ quickTap, ...expected }) => {
    expect(FIELDS.filter((f) => inactive({ ...DEFAULTS, quickTap }, f))).toEqual(expected.inactive);
  });
});
