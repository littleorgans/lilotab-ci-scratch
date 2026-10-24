// A segmented control: a fieldset of radios sharing one name on a track, so arrow keys move the choice and the control
// is one tab stop. The fieldset takes its name from the row label with `labelId`; callers own what a choice means.

import { el } from '../dom.ts';

type Value = string | number | boolean;

export interface Segmented<V extends Value> {
  node: HTMLFieldSetElement;
  show: (value: V) => void; // checks the radio for value, unchecks the rest
}

export function segmented<V extends Value>(
  name: string,
  choices: readonly (readonly [V, string])[],
  labelId: string,
  choose: (value: V) => void,
): Segmented<V> {
  const options = choices.map(([value, text]) => {
    const input = el('input', { type: 'radio', name, value: String(value) });
    input.addEventListener('change', () => {
      choose(value);
    });
    return el('label', { class: 'option' }, [input, text]);
  });
  const node = el('fieldset', { 'aria-labelledby': labelId }, [el('div', { class: 'track' }, options)]);
  return {
    node,
    show(value) {
      for (const input of node.querySelectorAll('input')) input.checked = input.value === String(value);
    },
  };
}
