// TB-12 hostSession.step (07-tests 2.1; 03-components 4.12; 04-state-machine 7): the host's local mode, open flag,
// hiding and close style, and the sensor sequence that composes it (hostInputStep).

import { describe, expect, it } from 'vite-plus/test';
import {
  hostInputStep,
  initialHostInputState,
  sessionStep,
  type Frame,
  type HostEffect,
  type HostInput,
  type HostInputState,
  type HostSession,
  type KeyFacts,
  type RowRef,
  type SessionEffect,
  type SessionInput,
  type StartView,
} from '../src/core/index.ts';
import { keyFacts, pointer, startView } from './host-fixtures.ts';

const SOURCE: RowRef = { window: 0, row: 0 };
const OTHER: RowRef = { window: 0, row: 1 };

const send = (input: HostInput): SessionInput => ({ kind: 'send', input });
const frame = (f: Frame): SessionInput => ({ kind: 'message', raw: { t: 'frame', frame: f } });
const startMessage = (start: StartView) => ({ kind: 'message', raw: { t: 'start', start, wake: null } }) as const;

const hold = (row: number, open = false): Extract<Frame, { mode: 'hold' }> => ({
  mode: 'hold',
  visible: true,
  open,
  window: 0,
  row,
  gone: [],
  copy: null,
});
const search = (results: RowRef[]): Frame => ({ mode: 'search', query: 'q', results, highlight: 0, copy: null });

const RELEASE: HostInput = { kind: 'release', inferred: false };
const ENTER: HostInput = { kind: 'enter' };
const LATCH: HostInput = { kind: 'latchSearch' };
const LEAVE: HostInput = { kind: 'leaveSearch' };
const post = (input: HostInput): SessionEffect => ({ kind: 'post', input });

const LIST = startView({ quickTap: 'list' });
const TOOLBAR = startView({ mode: 'search', binding: null, frame: search([SOURCE, OTHER]) });

interface Row {
  name: string;
  start: StartView;
  before: SessionInput[];
  input: SessionInput;
  effects: SessionEffect[];
  ending?: HostSession['ending'];
}

const rows: Row[] = [
  // hold release and cancel (03 4.12 Hiding, Closing)
  {
    name: 'C-TAP-10 T-68: list, release on the source opens the list and never hides',
    start: LIST,
    before: [],
    input: send(RELEASE),
    effects: [{ kind: 'open' }, post(RELEASE)],
  },
  {
    name: 'C-TAP-11 T-69: list, release in an open list with another row painted only posts and keeps a fade',
    start: LIST,
    before: [send(RELEASE), frame(hold(1, true))],
    input: send(RELEASE),
    effects: [post(RELEASE)],
    ending: 'fade',
  },
  {
    name: 'C-HOLD-24 T-27: list, release on another row posts without hiding and ends with a cut',
    start: LIST,
    before: [frame(hold(1))],
    input: send(RELEASE),
    effects: [post(RELEASE)],
    ending: 'cut',
  },
  {
    name: 'C-HOLD-09 C-A11Y-04: flip, release on another row hides with a cut',
    start: startView(),
    before: [frame(hold(1))],
    input: send(RELEASE),
    effects: [{ kind: 'hide', fade: false }, post(RELEASE)],
  },
  {
    name: 'C-HOLD-09 T-47: flip, release on the source hides with a fade',
    start: startView(),
    before: [],
    input: send(RELEASE),
    effects: [{ kind: 'hide', fade: true }, post(RELEASE)],
  },
  {
    // 03-components 4.12 Hiding: an ending hold stays hidden until the worker closes the channel.
    name: 'C-HOLD-09: flip, a queued frame after release cannot repaint the hidden list',
    start: startView(),
    before: [send(RELEASE)],
    input: frame(hold(1)),
    effects: [],
  },
  {
    name: 'C-HOLD-10 C-A11Y-04: flip, Esc on another row hides with a fade',
    start: startView(),
    before: [frame(hold(1))],
    input: send({ kind: 'cancel', cause: 'key' }),
    effects: [{ kind: 'hide', fade: true }, post({ kind: 'cancel', cause: 'key' })],
  },
  // open frames (T-68)
  {
    name: 'C-TAP-10 T-68: an open frame after a stale closed paint opens the list',
    start: LIST,
    before: [frame(hold(0))],
    input: frame(hold(0, true)),
    effects: [{ kind: 'paint', frame: hold(0, true) }, { kind: 'open' }],
  },
  {
    name: 'C-TAP-11 T-68: an older closed frame cannot undo an open frame, so a release only posts',
    start: LIST,
    before: [frame(hold(0, true)), frame(hold(0))],
    input: send(RELEASE),
    effects: [post(RELEASE)],
  },
  // search latch and back (T-18, T-31, T-67; 03 4.12)
  {
    name: 'C-SRCH-01 T-18: held F switches to search locally before posting',
    start: startView(),
    before: [],
    input: send(LATCH),
    effects: [{ kind: 'latch' }, post(LATCH)],
  },
  {
    name: 'C-SRCH-20 T-67: held F in a hold started list returns to hold locally before posting',
    start: startView(),
    before: [send(LATCH), frame(search([SOURCE]))],
    input: send(LEAVE),
    effects: [{ kind: 'unlatch' }, post(LEAVE)],
  },
  {
    name: 'C-SRCH-20: held F in a toolbar list only posts',
    start: TOOLBAR,
    before: [],
    input: send(LEAVE),
    effects: [post(LEAVE)],
  },
  {
    name: 'C-SRCH-01 C-SRCH-20: rapid F toggles paint nothing while a switch is unacknowledged',
    start: startView(),
    before: [send(LATCH), send(LEAVE), send(LATCH), frame(search([SOURCE]))],
    input: frame(hold(0)),
    effects: [],
  },
  {
    name: 'C-SRCH-01 C-SRCH-20: rapid F toggles paint the frame that acknowledges the last switch',
    start: startView(),
    before: [send(LATCH), send(LEAVE), send(LATCH), frame(search([SOURCE])), frame(hold(0))],
    input: frame(search([OTHER])),
    effects: [{ kind: 'paint', frame: search([OTHER]) }],
  },
  // commit candidates in search and the open list (C-A11Y-04: a switch cuts, else a fade)
  {
    name: 'C-SRCH-13 T-38: search, Enter on the source result ends with a fade',
    start: TOOLBAR,
    before: [frame(search([SOURCE]))],
    input: send(ENTER),
    effects: [post(ENTER)],
    ending: 'fade',
  },
  {
    name: 'C-SRCH-13 T-38: search, Enter on another result ends with a cut',
    start: TOOLBAR,
    before: [frame(search([OTHER]))],
    input: send(ENTER),
    effects: [post(ENTER)],
    ending: 'cut',
  },
  {
    name: 'C-SRCH-17 T-39: search, a pick of the source ends with a fade',
    start: TOOLBAR,
    before: [frame(search([OTHER]))],
    input: send({ kind: 'pick', row: SOURCE }),
    effects: [post({ kind: 'pick', row: SOURCE })],
    ending: 'fade',
  },
  {
    name: 'C-SRCH-17 T-39: search, a pick of another row ends with a cut',
    start: TOOLBAR,
    before: [],
    input: send({ kind: 'pick', row: OTHER }),
    effects: [post({ kind: 'pick', row: OTHER })],
    ending: 'cut',
  },
  {
    name: 'C-SRCH-16 T-40: search, Enter with no results only posts and keeps a fade',
    start: TOOLBAR,
    before: [frame(search([]))],
    input: send(ENTER),
    effects: [post(ENTER)],
    ending: 'fade',
  },
  {
    name: 'C-TAP-11 T-70: open, Enter on another row ends with a cut',
    start: LIST,
    before: [send(RELEASE), frame(hold(1, true))],
    input: send(ENTER),
    effects: [post(ENTER)],
    ending: 'cut',
  },
];

function run(start: StartView, inputs: SessionInput[]) {
  return inputs.reduce((step, input) => sessionStep(step.session, input), sessionStep(null, startMessage(start)));
}

// Key and pointer facts through hostInputStep, resumes included, as the host runs them within one DOM event.
function sense(state: HostInputState, facts: KeyFacts, owned = false, fieldValue: string | null = null) {
  const keyCode = facts.type === 'keydown' || facts.type === 'keyup' ? 1 : null; // any non IME key code
  const sensed = { kind: 'sensed', facts, keyCode, fieldValue, fieldSelected: false, pageRows: 8, owned } as const;
  let result = hostInputStep(state, sensed);
  const effects: HostEffect[] = [...result.effects];
  while (result.resume) {
    result = hostInputStep(result.state, result.resume);
    effects.push(...result.effects);
  }
  return { state: result.state, effects };
}

const started = (start: StartView) => hostInputStep(initialHostInputState(true), startMessage(start)).state;
const paint = (state: HostInputState, f: Frame) => hostInputStep(state, frame(f)).state;

const SWALLOW: HostEffect = { kind: 'consume', preventDefault: true, stopImmediatePropagation: true };
const MISSED: HostInput = { kind: 'release', inferred: true };
const HELD_PRESS = pointer('pointerdown', { meta: true });
const OUTSIDE_CANCEL: HostEffect[] = [{ kind: 'hide', fade: true }, post({ kind: 'cancel', cause: 'blur' })];

describe('TB-12 hostSession.step', () => {
  it.each(rows)('$name', ({ start, before, input, effects, ending }) => {
    const step = sessionStep(run(start, before).session, input);
    const actual = [...step.effects];
    const expected = [...effects];
    // 03-components 4.12 orders local actions before their post, but does not order paint and open on receipt.
    if (input.kind === 'message') {
      for (const list of [actual, expected]) list.sort((a, b) => a.kind.localeCompare(b.kind));
    }
    expect(actual).toEqual(expected);
    if (ending) expect(step.session?.ending).toBe(ending);
  });

  // Rows only observable through the host sensor sequence (04-state-machine 7, "Missed release in list mode").
  it.each([
    {
      name: 'C-HOLD-12 T-68: list, a first unheld Down after a missed release opens the list, then moves, swallowed',
      facts: keyFacts('ArrowDown'),
      effects: [{ kind: 'open' }, post(MISSED), SWALLOW, post({ kind: 'move', delta: 1 })],
    },
    {
      name: 'C-HOLD-12 T-68: list, a first pointer move after a missed release only opens the list',
      facts: pointer('pointermove'),
      effects: [{ kind: 'open' }, post(MISSED)],
    },
  ])('$name', ({ facts, effects }) => {
    expect(sense(started(LIST), facts).effects).toEqual(effects);
  });

  it.each([
    {
      name: 'C-HOLD-11 K-15 T-30: hold, a held press outside the shown list cancels with a fade, not swallowed',
      owned: false,
      effects: OUTSIDE_CANCEL,
    },
    {
      name: 'C-HOLD-22 K-08: hold, a held press inside the list is activity',
      owned: true,
      effects: [{ kind: 'consume', preventDefault: false, stopImmediatePropagation: true }, post({ kind: 'activity' })],
    },
  ])('$name', ({ owned, effects }) => {
    expect(sense(started(startView()), HELD_PRESS, owned).effects).toEqual(effects);
  });

  it('C-HOLD-11 K-15 C-SRCH-20: a held outside press cancels after local search and return before any frame', () => {
    const hidden = started(startView({ frame: { ...hold(0), visible: false } }));
    const latched = sense(hidden, keyFacts('f', { meta: true }));
    const released = sense(latched.state, keyFacts('f', { type: 'keyup', meta: true }));
    const returned = sense(released.state, keyFacts('f', { meta: true }));
    expect(sense(returned.state, HELD_PRESS).effects).toEqual(OUTSIDE_CANCEL);
  });

  it('C-SRCH-14 K-30: Esc with text empties the field, then sends query "" as the field would', () => {
    const input = { kind: 'field', type: 'input', trusted: true, fieldValue: 'abc', inputComposing: false } as const;
    const typed = hostInputStep(started(TOOLBAR), { ...input, owned: true }).state;
    const esc = sense(typed, keyFacts('Escape'), true, 'abc');
    expect(esc.effects).toEqual([SWALLOW, { kind: 'clearField' }, post({ kind: 'query', text: '' })]);
    expect(esc.state.sensor.lastSent).toBe('');
  });

  it('K-18 C-SRCH-14: IME Esc with key code 229 stays with the field before compositionstart', () => {
    const sensed = {
      kind: 'sensed',
      facts: keyFacts('Escape'),
      keyCode: 229,
      fieldValue: 'abc',
      fieldSelected: false,
      pageRows: 8,
      owned: true,
    } as const;
    const esc = hostInputStep(started(TOOLBAR), sensed);
    expect(esc.effects).toEqual([{ kind: 'consume', preventDefault: false, stopImmediatePropagation: true }]);
    expect(esc.state.sensor.lastSent).toBe('');
    expect(esc.resume).toBeNull();
  });

  const COPY = { title: 'Second', url: 'https://second.example/' };
  it.each([
    { name: 'Cmd+C copies the address', shift: false, copy: COPY, text: COPY.url },
    {
      name: 'Shift+Cmd+C copies the title and address',
      shift: true,
      copy: COPY,
      text: 'Second\nhttps://second.example/',
    },
    { name: 'with no copy text the host says it could not copy', shift: false, copy: null, text: null },
  ])('C-SRCH-26 K-34: search, the last painted frame decides: $name', ({ shift, copy, text }) => {
    const painted = paint(started(TOOLBAR), { ...search([OTHER]), copy });
    const pressed = sense(painted, keyFacts(shift ? 'C' : 'c', { meta: true, shift }), true, '');
    expect(pressed.effects).toEqual([SWALLOW, { kind: 'copy', text }]);
  });

  it('K-28 C-KEY-06: open, the keyup of a swallowed Down is swallowed too', () => {
    const open = startView({ quickTap: 'list', frame: hold(0, true) });
    const down = sense(started(open), keyFacts('ArrowDown'));
    expect(sense(down.state, keyFacts('ArrowDown', { type: 'keyup' })).effects).toEqual([SWALLOW]);
  });
});
