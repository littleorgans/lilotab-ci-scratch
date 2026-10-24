// Gesture timing log, measurement builds only: one record per gesture from the real core's steps, with times as ms
// after the press. The interaction harness's press is at 1000; each step here runs 1 ms after its event's at.

import { expect, onTestFinished, test, vi } from 'vite-plus/test';
import { readTiming, TIMING_KEY, TIMING_MAX, type TimingRecord } from '../src/browser/timing.ts';
import { init, step, type CoreEvent, type DeclineReason } from '../src/core/index.ts';
import { createGestureLog } from '../src/worker/timing/record.ts';
import { LIVE, STORED, esc, press, ready, release, status, tick, type Ev } from './interaction-harness.ts';

const ORIGIN = 1_700_000_000_000;

function setup() {
  const records: TimingRecord[] = [];
  const log = createGestureLog(ORIGIN, (r) => records.push(r));
  const ctx = {
    model: init('boot', undefined, STORED, LIVE.two).model,
    live: LIVE.two,
    last: null as string | null,
  };
  const event = (ev: Ev): CoreEvent => ev(ctx);
  const run = (e: CoreEvent) => {
    const before = ctx.model;
    const after = step(before, e);
    ctx.model = after.model;
    ctx.last = after.model.interaction?.id ?? ctx.last;
    log.stepped(before, e, after, e.at + 1);
  };
  const attempt = (n: number) => `boot:1:${String(n)}`;
  const decline = (n: number, reason: DeclineReason) => {
    log.declined(attempt(n), reason);
  };
  return { records, log, event, run, attempt, decline };
}

test('a quick tap after ready: prepared, launched and ready times, then a quick tap commit', () => {
  const { records, log, event, run, attempt } = setup();
  log.gate(500);
  const tap = event(press(0));
  log.prepared(tap, 1004);
  run(tap);
  log.launched(attempt(1), 1009);
  run(event(ready(20)));
  run(event(release(30)));
  expect(records).toEqual([
    {
      epoch: ORIGIN + 1000,
      entry: 'shortcut',
      holdDelayMs: 50,
      quickTap: 'flip',
      page: 'http',
      tabs: 7,
      windows: 2,
      workerAge: 1000,
      firstOfBoot: true,
      gateWaited: false,
      prepared: 4,
      stepped: 1,
      attempts: [{ host: 'overlay', start: 1, launched: 9, ready: 20, declined: null }],
      dwellDue: 50,
      dwell: null,
      shown: null,
      input: { at: 30, kind: 'release', input: 'release', inferred: false },
      presses: 0,
      pressAt: null,
      unheardPress: false,
      deadline: null,
      outcome: 'commit',
      switched: false,
      reason: 'quickTap',
      end: 31,
    },
  ]);
});

// C-HOLD-12, T-32: the release came before the popup listened, so the list shows and stays until idle cancels it.
test('a declined overlay, a late popup and a list with no host input until idle cancels it', () => {
  const { records, event, run, decline } = setup();
  run(event(press(0)));
  decline(1, 'unfocused');
  run(event(status(10, 'declined')));
  run(event(ready(150)));
  run(event(press(400)));
  run(event(tick(10_400)));
  expect(records).toMatchObject([
    {
      gateWaited: true,
      attempts: [
        { host: 'overlay', start: 1, ready: null, declined: { reason: 'unfocused', at: 10 } },
        { host: 'popup', start: 11, ready: 150, declined: null },
      ],
      dwell: 151,
      shown: 151,
      input: null,
      presses: 1,
      pressAt: 400,
      unheardPress: true,
      outcome: 'cancel',
      switched: false,
      reason: 'idle',
      end: 10_401,
    },
  ]);
});

// Expiry precedes the event row: a late release cannot become a quick tap or erase an idle cancellation.
test('a release that expires dwell is labelled release, and one after idle is not counted as input', () => {
  const { records, event, run } = setup();
  run(event(press(0)));
  run(event(ready(20)));
  run(event(release(60)));
  expect(records[0]).toMatchObject({ shown: 61, outcome: 'commit', reason: 'release' });
  run(event(press(100)));
  run(event(ready(170)));
  run(event(release(10_171)));
  expect(records[1]).toMatchObject({ shown: 71, input: null, outcome: 'cancel', reason: 'idle' });
});

// AC-02: preparation timed out before an interaction existed; only observed worker times are available.
test('a dropped preparation produces a minimal record on the press clock', () => {
  const { records, log } = setup();
  log.gate(1200);
  log.dropped('shortcut', 1000, 1250);
  expect(records).toEqual([
    {
      epoch: ORIGIN + 1000,
      entry: 'shortcut',
      workerAge: 1000,
      firstOfBoot: true,
      gateWaited: true,
      prepared: 250,
      outcome: 'dropped',
      reason: 'prepTimeout',
      end: 250,
    },
  ]);
});

// The persisted form stays compact, while the reader also accepts and bounds older array logs.
test('saved JSON and legacy arrays read back as bounded export records', async () => {
  const record = { outcome: 'dropped', reason: 'prepTimeout', epoch: ORIGIN };
  const records = Array.from({ length: TIMING_MAX + 1 }, (_, n) => ({ ...record, epoch: ORIGIN + n }));
  let stored: unknown = JSON.stringify(records);
  const get = vi.fn(() => Promise.resolve({ [TIMING_KEY]: stored }));
  vi.stubGlobal('chrome', { storage: { local: { get } } });
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  expect((await readTiming()).records).toEqual(records.slice(-TIMING_MAX));
  stored = records;
  expect((await readTiming()).records).toEqual(records.slice(-TIMING_MAX));
});

// Repeats before the host shows the list are ordinary stepping, with no evidence of a missed input.
test('a repeat before the list shows is distinguishable from a retry, and Escape is key input', () => {
  const { records, event, run } = setup();
  run(event(press(0)));
  run(event(press(10)));
  run(event(ready(60)));
  run(event(release(70)));
  expect(records[0]).toMatchObject({ pressAt: 10, shown: 61, unheardPress: false });
  run(event(press(100)));
  run(event(ready(160)));
  run(event(esc(170)));
  expect(records[1]).toMatchObject({ input: { kind: 'key', input: 'cancel' }, outcome: 'cancel', reason: 'key' });
});
