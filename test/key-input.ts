// Test key input shared by unit fixtures and the Chrome harness: a key's DOM code and its CDP key events.

import { NAMED_KEYS } from '../src/core/protocol/keys.ts';

const CODES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.values(NAMED_KEYS).map((k) => [k.key, k.code])),
  Meta: 'MetaLeft',
  Control: 'ControlLeft',
  Alt: 'AltLeft',
};

// The KeyboardEvent code a US layout gives `key`: letters as KeyX, named keys and modifiers from the table, else `key`.
export const codeOf = (key: string): string => CODES[key] ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key);

// CDP's modifiers bit mask for Input.dispatchKeyEvent.
export const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

// Windows virtual key codes CDP needs for keys whose code is not their upper case character code.
const VIRTUAL_CODES: Readonly<Record<string, number>> = {
  ArrowDown: 40,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowLeft: 37,
  Enter: 13,
  Escape: 27,
  Backspace: 8,
  Tab: 9,
  Meta: 91,
  Alt: 18,
};

const PHASES = { press: ['keyDown', 'keyUp'], down: ['keyDown'], up: ['keyUp'] } as const;

interface KeyInput {
  modifiers?: number; // MODIFIER_BITS sum
  text?: string; // the character the keyDown types
  phase?: keyof typeof PHASES; // a press is keyDown then its paired keyUp
}

// Input.dispatchKeyEvent params for `key`, in dispatch order.
export function keyEvents(key: string, { modifiers = 0, text, phase = 'press' }: KeyInput = {}) {
  const event = {
    key,
    code: codeOf(key),
    modifiers,
    windowsVirtualKeyCode: VIRTUAL_CODES[key] ?? key.toUpperCase().charCodeAt(0),
  };
  return PHASES[phase].map((type) => ({
    type,
    ...event,
    ...(type === 'keyDown' && text !== undefined ? { text } : {}),
  }));
}
