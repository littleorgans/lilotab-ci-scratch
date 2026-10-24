// Element builder the options and welcome pages share. Text is always set as text, never as markup (C-SEC-03).

type Child = Node | string;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string>> = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

// One card row: the label with any lines under it on the left, the control, if any, on the right. A label id lets
// the control take the label as its name.
export function row(label: string, lines: readonly Node[], control?: Node, labelId?: string): HTMLDivElement {
  const name = el('span', labelId === undefined ? { class: 'label' } : { class: 'label', id: labelId }, [label]);
  return el('div', { class: 'row' }, [el('div', { class: 'text' }, [name, ...lines]), ...(control ? [control] : [])]);
}

// A muted line under a row's label.
export const hint = (text: string): HTMLParagraphElement => el('p', { class: 'hint' }, [text]);

// A labelled group: the label above, its rows in one card. An id makes it an anchor for the side index (C-SET-26).
export const group = (label: string, rows: readonly Node[], id?: string): HTMLElement =>
  el('section', id === undefined ? { class: 'group' } : { class: 'group', id }, [
    el('h2', {}, [label]),
    el('div', { class: 'card' }, rows),
  ]);
