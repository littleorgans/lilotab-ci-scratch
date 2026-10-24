import { pause, scrub } from './support.mjs';
import { HELD } from './chrome.mjs';
export const state = (c, h) =>
  c.inspect(h).catch((e) => {
    if (/closed|detached/i.test(e.message)) return { connected: false, shown: false };
    throw e;
  });
export const probe = (c, h) =>
  c.probe(h).catch((e) => {
    if (/closed|detached/i.test(e.message))
      return { closed: true, animations: [], events: [], intervals: [], activeSensors: [] };
    throw e;
  });
// A check that threw, as a harness FAIL with the last host as the error left it; a check that cleans up records this
// before its cleanup resets the host.
export const thrown = async (c, err) => ({
  pass: false,
  harnessError: scrub(err.message),
  measured: {
    error: scrub(err.message),
    lastHost: c.last ? await state(c, c.last) : null,
    probe: c.last ? await probe(c, c.last) : null,
  },
});
const intervals = (p) => (p.intervals ?? []).filter((t) => t.active && t.ms === 20000);
export const active = (c, windowId = c.source.windowId) =>
  c.workerEval(
    `(async()=>{const [t]=await chrome.tabs.query({windowId:${windowId},active:true});return {id:t.id,title:t.title,windowId:t.windowId}})()`,
  );
async function opened(c, flavor, options = {}) {
  const h = await c.open(flavor, options),
    initial = await state(c, h);
  await c.release(h);
  await pause(25);
  return { h, initial, released: await state(c, h) };
}
const downEvents = (p) => p.events.filter((e) => e.kind === 'input' && e.key === 'ArrowDown');
export function behaviorScenarios(c, e, add) {
  for (const flavor of ['overlay', 'popup']) {
    add(
      `10-quick-tap-${flavor}`,
      'Quick tap shows current tab at once despite 200 ms hold delay, stays open, and takes list focus (AC-16; C-TAP-10, C-HOLD-24)',
      async () => {
        const started = Date.now(),
          { h, initial, released } = await opened(c, flavor, { holdDelayMs: 200 });
        const measured = {
          initial,
          released,
          active: await active(c),
          timers: await c.workerTimers(),
          probe: await probe(c, h),
          elapsedMs: Date.now() - started,
          hostReadyWall: h.readyAt,
          visibleWall: h.visibleAt,
          readyToVisibleMs: h.readyAt === null ? null : h.visibleAt - h.readyAt,
        };
        return {
          pass:
            initial.selected?.title === 'H1 Source' &&
            released.shown &&
            released.selected?.title === 'H1 Source' &&
            released.listFocused &&
            measured.active.id === c.source.id &&
            measured.timers.some((t) => Math.abs(t.ms - 300000) < 200) &&
            measured.readyToVisibleMs !== null &&
            measured.readyToVisibleMs < 100,
          measured,
        };
      },
    );
    add(
      `10-missed-release-down-${flavor}`,
      'First unheld Down infers release and moves once; paired keydown and keyup are swallowed (AC-16; C-HOLD-12, C-TAP-11)',
      async () => {
        const h = await c.open(flavor),
          before = await state(c, h);
        await c.resetProbe(h);
        await c.key(h, 'ArrowDown');
        await pause(30);
        const after = await state(c, h),
          p = await probe(c, h);
        const expected = before.rows?.[(before.rows.findIndex((r) => r.selected) + 1) % before.rows.length]?.title;
        const events = downEvents(p),
          downstream = p.events.filter((e) => e.kind === 'downstream' && e.key === 'ArrowDown');
        return {
          pass:
            after.shown &&
            after.listFocused &&
            after.selected?.title === expected &&
            (await active(c)).id === c.source.id &&
            events.length === 2 &&
            events.every((e) => e.trusted && e.prevented) &&
            downstream.length === 0,
          measured: { before, after, expected, events, downstream, probe: p },
        };
      },
    );
    add(
      `10-search-return-${flavor}`,
      'F then held F restores open hold and list focus; exactly one original ping interval survives (AC-16; C-SRCH-20, C-SW-03)',
      async () => {
        const { h, released } = await opened(c, flavor),
          before = await probe(c, h);
        await c.key(h, 'f');
        await pause(110);
        const search = await state(c, h),
          during = await probe(c, h);
        await c.key(h, 'f', HELD.modifier);
        await pause(110);
        const back = await state(c, h),
          after = await probe(c, h);
        const old = intervals(before),
          mid = intervals(during),
          end = intervals(after);
        return {
          pass:
            released.shown &&
            search.search &&
            search.fieldFocused &&
            back.listFocused &&
            !back.search &&
            old.length === 1 &&
            mid.length === 1 &&
            end.length === 1 &&
            old[0].token === mid[0].token &&
            old[0].token === end[0].token,
          measured: { released, search, back, before, during, after },
        };
      },
    );
    add(
      `10-command-release-enter-${flavor}`,
      'Another command steps; a subsequent release is ignored; Enter commits that selected tab (AC-16; C-TAP-11)',
      async () => {
        const { h, released } = await opened(c, flavor);
        await c.command();
        await pause(30);
        const stepped = await state(c, h);
        await c.release(h);
        await pause(25);
        const ignored = await state(c, h);
        await c.key(h, 'Enter');
        await pause(100);
        const ended = await state(c, h),
          target = await active(c);
        return {
          pass:
            released.shown &&
            stepped.selected?.title !== released.selected?.title &&
            ignored.shown &&
            ignored.selected?.title === stepped.selected?.title &&
            !ended.connected &&
            target.title === stepped.selected?.title,
          measured: { released, stepped, ignored, ended, target, probe: await probe(c, h) },
        };
      },
    );
    add(
      `10-row-pick-${flavor}`,
      'Trusted primary row click in open hold commits the clicked tab (AC-16; C-HOLD-22)',
      async () => {
        const { h, released } = await opened(c, flavor),
          row = released.rows?.find((r) => r.title === 'H1 Other');
        if (row) await c.click(h, row.rect.x + row.rect.width / 2, row.rect.y + row.rect.height / 2);
        await pause(110);
        const after = await state(c, h),
          target = await active(c);
        return {
          pass: released.shown && !!row && !after.connected && target.id === c.other.id,
          measured: { released, row: row ?? null, after, target },
        };
      },
    );
    add(
      `10-tab-focus-${flavor}`,
      'Tab and its paired keyup are swallowed; focus stays on the open list (AC-16; C-TAP-11)',
      async () => {
        const { h, released } = await opened(c, flavor);
        await c.resetProbe(h);
        await c.key(h, 'Tab');
        await pause(20);
        const after = await state(c, h),
          p = await probe(c, h),
          events = p.events.filter((x) => x.kind === 'input' && x.key === 'Tab');
        return {
          pass:
            released.listFocused &&
            after.listFocused &&
            after.shown &&
            events.length === 2 &&
            events.every((x) => x.trusted && x.prevented),
          measured: { released, after, events, probe: p },
        };
      },
    );
    add(
      `10-outside-press-${flavor}`,
      flavor === 'popup'
        ? 'Outside page press plus native window blur substitute cancels popup and preserves source; OS outside dismissal unverified (AC-16; C-POP-04)'
        : 'A press outside the list cancels and preserves the source tab (AC-16; C-TAP-11)',
      async () => {
        const { h, released } = await opened(c, flavor);
        const stimulus = { method: 'CDP pointer press at page corner', coverage: 'direct' };
        if (flavor === 'overlay') await c.click(h, 4, 4);
        else {
          await c.sourcePage.bringToFront();
          await c.click(c.overlay, 4, 4);
          await pause(20);
          stimulus.afterTargetedPress = await state(c, h);
          stimulus.method =
            'CDP press on source page; minimize and restore source browser window if headless popup retains focus';
          if (stimulus.afterTargetedPress.connected) {
            stimulus.coverage = 'native window blur substitute';
            stimulus.osOutsideDismissalUnverified = true;
            try {
              await c.workerEval(`chrome.windows.update(${c.source.windowId},{state:'minimized'})`);
              await pause(35);
              stimulus.window = await c.workerEval(
                `(async()=>{const w=await chrome.windows.get(${c.source.windowId});return {state:w.state,focused:w.focused}})()`,
              );
              stimulus.afterNativeBlur = await state(c, h);
            } finally {
              await c.workerEval(`chrome.windows.update(${c.source.windowId},{state:'normal'})`);
            }
          }
        }
        await pause(110);
        const after = await state(c, h),
          target = await active(c);
        return {
          pass:
            released.shown &&
            !after.connected &&
            target.id === c.source.id &&
            (stimulus.coverage === 'direct' ||
              (stimulus.window?.state === 'minimized' && stimulus.window.focused === false)),
          coverage: stimulus.coverage,
          measured: { released, after, target, stimulus },
        };
      },
    );
    add(
      `10-list-blur-${flavor}`,
      'Native list blur cancels; source focus returns and interval is cleared (AC-16; C-HOLD-11, C-SW-02)',
      async () => {
        const { h, released } = await opened(c, flavor);
        const blur = await c
          .panelCall(h, function () {
            const root = this.getRootNode(),
              a = root.activeElement;
            const before = a?.className;
            a?.blur();
            return { before, rootFocusAfterBlur: root.activeElement?.className ?? null };
          })
          .catch(() => null);
        await pause(110);
        const after = await state(c, h),
          p = await probe(c, h),
          page = await c.sourcePage.evaluate(() => ({
            focused: document.activeElement?.id,
            tag: document.activeElement?.tagName,
            hasFocus: document.hasFocus(),
          }));
        return {
          pass:
            released.listFocused &&
            blur?.before === 'list' &&
            !after.connected &&
            intervals(p).length === 0 &&
            (flavor === 'popup' || page.focused === 'page-input'),
          measured: { released, blur, after, page, probe: p },
        };
      },
    );
    add(
      `10-ping-idle-${flavor}`,
      'One 20 second interval sends a ping after search return; the same five minute worker idle deadline remains (AC-16; C-SW-03, C-TAP-11)',
      async () => {
        const { h, released } = await opened(c, flavor);
        await c.key(h, 'f');
        await pause(100);
        await c.key(h, 'f', HELD.modifier);
        await pause(100);
        const before = await probe(c, h),
          timersBefore = await c.workerTimers(),
          messagesBefore = await c.workerMessages();
        const tick = await c
          .own(
            h,
            '(()=>{const rows=__h1.intervals.filter(x=>x.active&&x.ms===20000);for(const x of rows)x.call();return {count:rows.length,visible:document.visibilityState,focused:document.hasFocus()}})()',
          )
          .catch(() => null);
        await pause(35);
        const after = await probe(c, h),
          timersAfter = await c.workerTimers(),
          messages = (await c.workerMessages()).slice(messagesBefore.length);
        const idleBefore = timersBefore.find((x) => Math.abs(x.ms - 300000) < 200),
          idleAfter = timersAfter.find((x) => x.token === idleBefore?.token);
        return {
          pass:
            released.shown &&
            intervals(before).length === 1 &&
            intervals(after).length === 1 &&
            tick?.count === 1 &&
            tick.focused &&
            idleBefore &&
            idleAfter &&
            idleBefore.due === idleAfter.due &&
            intervals(after)[0].fires === intervals(before)[0].fires + 1 &&
            messages.filter((m) => m.input?.kind === 'ping').length === 1,
          measured: { released, tick, before, after, timersBefore, timersAfter, messages },
        };
      },
    );
    add(
      `10-release-switch-${flavor}`,
      'Before latching, stepping then releasing switches immediately to another tab (AC-16; C-HOLD-24)',
      async () => {
        const h = await c.open(flavor),
          initial = await state(c, h);
        await c.key(h, 'ArrowDown', HELD.modifier);
        await pause(30);
        const stepped = await state(c, h);
        await c.release(h);
        await pause(30);
        const after = await state(c, h),
          target = await active(c);
        return {
          pass:
            initial.shown &&
            stepped.selected?.title !== 'H1 Source' &&
            !after.connected &&
            target.title === stepped.selected?.title,
          measured: { initial, stepped, after, target },
        };
      },
    );
  }
}
