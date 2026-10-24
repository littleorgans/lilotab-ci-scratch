// One host session's input (03-components 4.9, 04-state-machine 7): sensor facts through the key map and the session
// reducer, with the memory the sensors keep between events. Hosts read the DOM and run the effects in order; these
// rules decide what each trusted event sends and whether the page may see it.

import {
  NO_PRESSES,
  classify,
  queryInput,
  trackPress,
  type Classified,
  type KeyContext,
  type KeyFacts,
  type Presses,
} from '../keymap/index.ts';
import {
  sessionStep,
  type Binding,
  type HostSession,
  type SessionEffect,
  type SessionInput,
} from '../protocol/index.ts';

// The field's events: query sensing (K-09, K-19); in the overlay none of them may reach the page (C-SRCH-05).
export const FIELD_EVENTS = [
  'input',
  'beforeinput',
  'textInput',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'keypress',
] as const;
export type FieldEvent = (typeof FIELD_EVENTS)[number];

// What the host reads from one key or pointer event, once; a replay reuses it.
export interface KeySensor {
  kind: 'sensed';
  facts: KeyFacts; // composing: the event's own isComposing; the composition remembered here is added to it
  keyCode: number | null; // null for a pointer; IME key code 229 can arrive with isComposing false
  fieldValue: string | null; // the field's value while it has focus, else null
  owned: boolean; // the event happened inside the list
}

export interface FieldSensor {
  kind: 'field';
  type: FieldEvent;
  trusted: boolean;
  fieldValue: string | null;
  inputComposing: boolean | null; // an input event's isComposing; null for any other event
  owned: boolean;
}

export type HostSensor = KeySensor | FieldSensor;

export interface SensorMemory {
  composing: boolean; // an IME composition is active in the field (K-18)
  lastSent: string; // the last query sent (K-09, K-19)
  presses: Presses; // K-20
  swallowed: ReadonlySet<string>; // codes whose keydown was swallowed, so their keyup is too (C-KEY-06)
}

export interface HostInputState {
  session: HostSession | null; // mode, quiet and admission (03 4.12, 05 4.5); null before start
  binding: Binding | null; // the admitted start view's, for classification
  sensor: SensorMemory;
}

export type HostEvent = SessionInput | HostSensor;

// Whether the page may see the event: a swallowed key is both, an event inside the list only stops (C-KEY-06).
export type HostEffect =
  | SessionEffect
  | { kind: 'consume'; preventDefault: boolean; stopImmediatePropagation: boolean };

// The rest of one key or pointer event, once the effects before it have run: classification after the query a
// recovered composition sent, or the open list's reading after the release that opened it.
export type HostResume =
  | { kind: 'resume'; phase: 'classify'; sensed: KeySensor }
  | { kind: 'resume'; phase: 'replay'; sensed: KeySensor; facts: KeyFacts; swallow: boolean };

export interface HostInputResult {
  state: HostInputState;
  effects: readonly HostEffect[];
  resume: HostResume | null;
}

export const initialHostInputState = (): HostInputState => ({
  session: null,
  binding: null,
  sensor: { composing: false, lastSent: '', presses: NO_PRESSES, swallowed: new Set() },
});

interface Step {
  state: HostInputState;
  effects: readonly HostEffect[];
}

const still = (state: HostInputState): Step => ({ state, effects: [] });
const done = (step: Step): HostInputResult => ({ ...step, resume: null });

const then = (first: Step, next: (s: HostInputState) => Step): Step => {
  const second = next(first.state);
  return { state: second.state, effects: [...first.effects, ...second.effects] };
};

const contextOf = (session: HostSession, binding: Binding | null): KeyContext => ({
  binding,
  mode: session.mode,
  origin: session.origin,
  open: session.open,
});

// The session reducer decides switches, hiding and admission (03 4.12). A start brings its binding. Back to hold the
// query goes with the field (T-67, K-22): no composition, query or press is left for the next search.
function stepSession(s: HostInputState, input: SessionInput): Step {
  const next = sessionStep(s.session, input);
  let { binding, sensor } = s;
  for (const effect of next.effects) {
    if (effect.kind === 'start') binding = effect.start.binding;
    if (effect.kind === 'unlatch') sensor = { ...sensor, composing: false, lastSent: '', presses: NO_PRESSES };
  }
  return { state: { session: next.session, binding, sensor }, effects: next.effects };
}

// The full text, only when it changed and no composition is active (K-09, K-19); the press sent its query (K-20).
function query(s: HostInputState, value: string): Step {
  const input = queryInput(value, s.sensor.lastSent, s.sensor.composing);
  if (input?.kind !== 'query') return still(s);
  const sensor = { ...s.sensor, lastSent: input.text, presses: NO_PRESSES };
  return stepSession({ ...s, sensor }, { kind: 'send', input });
}

// Field (K-09, K-19): search with the field focused only; an owned field event never reaches the page (C-SRCH-05).
function field(s: HostInputState, e: FieldSensor): Step {
  if (!e.trusted || s.session?.mode !== 'search' || e.fieldValue === null) return still(s);
  const { fieldValue } = e;
  let { composing } = s.sensor;
  if (e.type === 'compositionstart') composing = true;
  if (e.type === 'compositionend') composing = false;
  if (e.type === 'input' && e.inputComposing !== null) composing = e.inputComposing;
  const step: Step = {
    state: { ...s, sensor: { ...s.sensor, composing } },
    effects: e.owned ? [{ kind: 'consume', preventDefault: false, stopImmediatePropagation: true }] : [],
  };
  if (e.type !== 'input' && e.type !== 'compositionend') return step;
  return then(step, (t) => query(t, fieldValue));
}

// Keys and pointer (K-01 to K-08, K-10 to K-12, K-14, K-18, K-20). Chromium can emit an untrusted compositionend.
// Recover only from a trusted completion fact, such as the keyup of the key that confirmed the text, and send the
// final query before classifying Enter. Key code 229 still belongs to the IME even when isComposing is false.
function sensed(s: HostInputState, e: KeySensor): HostInputResult {
  if (!e.facts.trusted) return done(still(s)); // K-16, C-SEC-01
  if (
    s.sensor.composing &&
    s.session?.mode === 'search' &&
    e.fieldValue !== null &&
    e.keyCode !== null &&
    !e.facts.composing &&
    e.keyCode !== 229
  ) {
    const recovered = query({ ...s, sensor: { ...s.sensor, composing: false } }, e.fieldValue);
    return { ...recovered, resume: { kind: 'resume', phase: 'classify', sensed: e } };
  }
  return classifySensed(s, e);
}

// A held press outside the shown list leaves it, as one in search or the open list does (K-08, K-15); the page still
// sees the press.
function outside(c: Classified, e: KeySensor, session: HostSession): Classified {
  const leaving = e.facts.type === 'pointerdown' && c.input?.kind === 'activity' && !e.owned && session.visible;
  return leaving ? { input: { kind: 'cancel', cause: 'blur' }, swallow: false } : c;
}

function classifySensed(s: HostInputState, e: KeySensor): HostInputResult {
  const { session } = s;
  if (!session || session.quiet) return done(still(s));
  const facts = { ...e.facts, composing: s.sensor.composing || e.facts.composing };
  const classified = outside(classify(facts, contextOf(session, s.binding)), e, session);
  // A release that opens the list here, a missed one included (K-03), is sent first; the same event then means what
  // it means in the open list, so a first unheld Down moves and is swallowed (T-68).
  if (classified.input?.kind === 'release' && session.quickTap === 'list' && !session.open) {
    const released = stepSession(s, { kind: 'send', input: classified.input });
    return { ...released, resume: { kind: 'resume', phase: 'replay', sensed: e, facts, swallow: classified.swallow } };
  }
  return done(finish(s, e, facts, classified));
}

// The session after the release: only an open list reads the event again.
function replay(s: HostInputState, r: Extract<HostResume, { phase: 'replay' }>): HostInputResult {
  const { session } = s;
  const classified = session?.open
    ? classify(r.facts, contextOf(session, s.binding))
    : { input: null, swallow: r.swallow };
  return done(finish(s, r.sensed, r.facts, classified));
}

// After any input sent first: whether the page may see the event, then the press K-20 reports, then its own input.
function finish(s: HostInputState, e: KeySensor, f: KeyFacts, { input, swallow }: Classified): Step {
  const key = e.keyCode !== null;
  const search = s.session?.mode === 'search';
  const paired = !swallow && f.type === 'keyup' && s.sensor.swallowed.has(f.code);
  const swallowed = new Set(s.sensor.swallowed);
  if (swallow && key) swallowed.add(f.code);
  if (paired) swallowed.delete(f.code);
  // Focus stays in the field while searching (03 4.12): Tab would hand typing to the page.
  const tab = search && f.type === 'keydown' && f.key === 'Tab';
  const consumed = swallow || paired;
  const tracked = search && key ? trackPress(s.sensor.presses, f, input) : { presses: s.sensor.presses, input: null };
  let step: Step = {
    state: { ...s, sensor: { ...s.sensor, swallowed, presses: tracked.presses } },
    effects:
      consumed || tab || e.owned
        ? [{ kind: 'consume', preventDefault: consumed || tab, stopImmediatePropagation: consumed || e.owned }]
        : [],
  };
  for (const next of [tracked.input, input]) {
    if (next) step = then(step, (t) => stepSession(t, { kind: 'send', input: next }));
  }
  return step;
}

// Run the effects in order after taking the state, so a sensor that fires during an effect reads the new mode; then
// step a resume, within the same DOM event, with the state current once those effects have run.
export function hostInputStep(s: HostInputState, event: HostEvent | HostResume): HostInputResult {
  switch (event.kind) {
    case 'message':
    case 'send':
      return done(stepSession(s, event));
    case 'field':
      return done(field(s, event));
    case 'sensed':
      return sensed(s, event);
    case 'resume':
      return event.phase === 'classify' ? classifySensed(s, event.sensed) : replay(s, event);
  }
}
