// Setting rows: one segmented control per SCHEMA field, in its field's group; FIELDS order is the order within a group,
// so a field added to SCHEMA with a group adds its row and nothing else (06 4.1, C-SET).

import {
  FIELDS,
  FLIP_ONLY,
  SCHEMA,
  inactive,
  type SettingField,
  type SettingGroup,
  type Settings,
} from '../../core/index.ts';
import { OPTIONS_TEXT as T, SETTING_TEXT } from '../../strings.ts';
import { el, hint, row } from '../dom.ts';
import { segmented, type Segmented } from './segmented.ts';

export type Choose = (field: SettingField, value: Settings[SettingField]) => void;

const controls = new Map<SettingField, { line: HTMLElement; control: Segmented<Settings[SettingField]> }>();
const flipOnly = el('p', { class: 'hint', hidden: '' }, [T.flipOnly]);

// One segmented control. Its values come only from SCHEMA, its names, unit and hint from the catalogue (06 4.1).
function settingRow(field: SettingField, choose: Choose): HTMLElement {
  const { label, unit, hint: text } = SETTING_TEXT[field];
  const names: Readonly<Record<string, string>> = SETTING_TEXT[field].values;
  const values: readonly Settings[SettingField][] = SCHEMA[field].values;
  const labelId = `label-${field}`;
  const control = segmented(
    field,
    values.map((v) => [v, names[String(v)] ?? String(v)] as const),
    labelId,
    (v) => {
      choose(field, v);
    },
  );
  const set = control.node;
  if (unit !== undefined) {
    set.setAttribute('aria-describedby', `unit-${field}`);
    set.append(el('span', { class: 'unit', id: `unit-${field}` }, [unit]));
  }
  const lines = [...(text === undefined ? [] : [hint(text)]), ...(field === 'quickTap' ? [flipOnly] : [])];
  const line = row(label, lines, set, labelId);
  controls.set(field, { line, control });
  return line;
}

export const settingRows = (group: SettingGroup, choose: Choose): HTMLElement[] =>
  FIELDS.filter((f) => SCHEMA[f].section === group).map((f) => settingRow(f, choose));

// A projection of the shown values. Open tab list leaves the Flip to last tab rows in place, dimmed and out of the tab
// order (C-SET-19).
export function renderRows(shown: Settings, editable: boolean): void {
  for (const [field, { line, control }] of controls) {
    const off = inactive(shown, field);
    line.classList.toggle('off', off);
    control.node.disabled = !editable || off;
    control.show(shown[field]);
  }
  flipOnly.hidden = !FLIP_ONLY.some((f) => inactive(shown, f));
}
