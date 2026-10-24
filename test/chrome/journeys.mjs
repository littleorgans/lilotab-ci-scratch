// End to end journeys JY-1 to JY-6 and the checks JY-7 to JY-9 over their traffic (07-tests 2.3). Each journey
// asserts the outcome (the active tab, its window, what stayed open), never the timing path (07-tests 1, rule 6).
import { browserPage, pause, until } from './support.mjs';
import { HELD } from './chrome.mjs';
import { state, active } from './behavior.mjs';

const MARK = '__h1-control';
const CONTROL_URL = `http://h1-control.invalid/${MARK}`;

// The first observation for which `ok` holds, or a last one read when none does in time.
const settle = (read, ok, ms = 1500) =>
  until(async () => {
    const value = await read();
    return ok(value) && value;
  }, ms).catch(() => read());
const where = (c, title) =>
  c.workerEval(
    `chrome.tabs.query({title:${JSON.stringify(title)}}).then(([t])=>t?{id:t.id,title:t.title,active:t.active,windowId:t.windowId}:null)`,
  );
// Whether the extension asked to bring this window forward since the wall time `since` (C-WIN-07).
const asked = async (c, windowId, since) =>
  (await c.focusRequests()).some((r) => r.windowId === windowId && r.wall >= since);
// The tab with this title once it is active and its window was asked forward since the press.
const landedOn = (c, title, since) =>
  settle(
    async () => {
      const t = await where(c, title);
      return t && { ...t, front: await asked(c, t.windowId, since) };
    },
    (t) => t?.active && t.front,
  );

// Every leaf is a number: the recents envelope holds tab and window ids and use numbers only (C-DATA-01).
const numbersOnly = (v) =>
  typeof v === 'number' || (v !== null && typeof v === 'object' && Object.values(v).every(numbersOnly));

// Records every page, popup and worker session's network requests, console writes and storage changes for the run.
class Traffic {
  requests = [];
  writes = [];
  storage = [];
  contexts = new Map();
  constructor(c) {
    this.c = c;
  }
  async watch(session, kind) {
    const sid = session.id();
    session.on('Runtime.executionContextCreated', ({ context }) =>
      this.contexts.set(`${sid}:${context.id}`, {
        sid,
        origin: context.origin,
        name: context.name,
        type: context.auxData?.type,
        isDefault: context.auxData?.isDefault,
      }),
    );
    session.on('Network.requestWillBeSent', ({ request, documentURL, initiator }) =>
      this.requests.push({ kind, sid, url: request.url, documentURL, initiator }),
    );
    session.on('Runtime.consoleAPICalled', (e) =>
      this.writes.push({
        kind,
        sid,
        context: `${sid}:${e.executionContextId}`,
        source: `console.${e.type}`,
        text: e.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
      }),
    );
    session.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) =>
      this.writes.push({
        kind,
        sid,
        context: `${sid}:${d.executionContextId}`,
        source: 'exception',
        text: d.exception?.description ?? d.text,
      }),
    );
    session.on('Log.entryAdded', ({ entry }) =>
      this.writes.push({ kind, sid, context: null, source: `log.${entry.source}`, text: entry.text, url: entry.url }),
    );
    await session.send('Network.enable');
    await session.send('Log.enable');
    if (kind !== 'worker') return;
    session.on('Runtime.bindingCalled', ({ name, payload }) => {
      if (name === '__h1Storage') this.storage.push(JSON.parse(payload));
    });
    await session.send('Runtime.addBinding', { name: '__h1Storage' });
    // A worker attached at its start defines chrome a moment later.
    await until(
      () =>
        this.c.eval(
          session,
          "typeof chrome!=='undefined'&&!!chrome.storage?.onChanged&&!chrome.storage.onChanged.addListener((changes,area)=>__h1Storage(JSON.stringify({area,changes})))",
        ),
      10000,
    );
  }
  get origin() {
    return `chrome-extension://${this.c.extensionId}`;
  }
  // A session whose document is one of this extension's pages: the popup.
  extensionPage(sid) {
    return [...this.contexts.values()].some((x) => x.sid === sid && x.isDefault && x.origin === this.origin);
  }
  // The extension's own: the worker, its pages, and in a web page its isolated world or a request it initiated. A
  // browser's own page (Opera's start page fetches its offers) is no web page, so its other origins are not.
  ownRequest(r) {
    if (!/^(https?|wss?|ftp):/i.test(r.url)) return false;
    if (r.kind === 'worker' || this.extensionPage(r.sid) || r.documentURL?.startsWith(this.origin)) return true;
    const webPage = /^https?:/i.test(r.documentURL ?? '');
    return (
      (webPage && new URL(r.url).origin !== new URL(this.c.base).origin) ||
      JSON.stringify(r.initiator).includes(this.origin)
    );
  }
  ownWrite(w) {
    if (w.kind === 'worker' || this.extensionPage(w.sid) || w.url?.startsWith(this.origin)) return true;
    const context = this.contexts.get(w.context);
    return context?.type === 'isolated' && context.origin === this.origin;
  }
}

export function journeyScenarios(c, e, add) {
  const traffic = new Traffic(c);
  c.observe((session, kind) => traffic.watch(session, kind));

  // Runs a journey that may add tabs or move focus, then removes those tabs and restores the fixture's recent order.
  const restoring = (fn) => async () => {
    const made = [];
    try {
      return await fn(made);
    } finally {
      for (const t of made) await c.workerEval(`chrome.tabs.remove(${t.id})`).catch(() => {});
      await c.recentOrder();
    }
  };
  const addTab = async (made, windowId, url) => {
    const tab = await c.workerEval(
      `chrome.tabs.create({windowId:${windowId},url:${JSON.stringify(url)},active:false})`,
    );
    made.push(tab);
    return c.loaded(tab.id);
  };
  // A press once the host listens, then the release: a quick tap, whichever timing path the automation takes.
  const tap = async (tab) => c.release(await c.open('overlay', { tab, quickTap: 'flip', shown: false }));

  add(
    'JY-1-tap-toggles',
    'C-TAP-01, C-TAP-02, C-TAP-08, KB-02: Other then Source used; a tap lands on Other, the next tap back on Source',
    restoring(async () => {
      await c.grant(c.other.id);
      await c.focus(c.source.id);
      await tap(c.source);
      const first = await settle(
        () => active(c, c.source.windowId),
        (t) => t.id === c.other.id,
      );
      await tap(c.other);
      const second = await settle(
        () => active(c, c.source.windowId),
        (t) => t.id === c.source.id,
      );
      return { pass: first.id === c.other.id && second.id === c.source.id, measured: { first, second } };
    }),
  );

  add(
    'JY-2-hold-other-window',
    'C-HOLD-01, C-HOLD-09, C-WIN-01, C-WIN-04, C-WIN-07: past the hold delay list and strip show; Down, Right, release lands on the highlighted tab of another window, brought forward',
    restoring(async () => {
      const h = await c.open('overlay', { quickTap: 'flip', holdDelayMs: 50 }),
        shown = await state(c, h);
      await c.key(h, 'ArrowDown', HELD.modifier);
      await c.key(h, 'ArrowRight', HELD.modifier);
      await pause(30);
      const picked = await state(c, h);
      await c.release(h);
      const landed = await landedOn(c, picked.selected?.title, h.invokedAt);
      return {
        pass:
          shown.shown &&
          shown.strip?.cells.length > 1 &&
          landed?.active &&
          landed.front &&
          landed.windowId !== c.source.windowId,
        measured: { shown, picked, landed },
      };
    }),
  );

  add(
    'JY-2-all-windows-step',
    'C-WIN-06, global step D1: All windows, Source then Window1 then Step used; hold, press again, release lands on Step, the second most recent tab of the other window',
    restoring(async (made) => {
      const w1 = c.windows[1];
      const step = await addTab(made, w1.id, `${c.base}/?name=Step`);
      for (const id of [step.id, w1.tabs[0].id, c.source.id]) await c.focus(id);
      const h = await c.open('overlay', { quickTap: 'flip', quickScope: 'all' }),
        first = await state(c, h);
      await c.command();
      await pause(30);
      const stepped = await state(c, h);
      await c.release(h);
      const landed = await landedOn(c, 'H1 Step', h.invokedAt);
      return {
        pass: landed?.active && landed.front && landed.id === step.id,
        measured: { first: first.selected, stepped: stepped.selected, landed },
      };
    }),
  );

  add(
    'JY-3-search-other-window',
    'C-SRCH-01, C-SRCH-02, C-SRCH-03, C-SRCH-06, C-SRCH-13: held F focuses the search field; after release, typing a word from another window and Enter lands there',
    restoring(async () => {
      const h = await c.open('overlay', { quickTap: 'flip', holdDelayMs: 200, shown: false });
      await c.key(h, 'f', HELD.modifier);
      const search = await settle(
        () => state(c, h),
        (s) => s.search && s.fieldFocused,
      );
      await c.release(h);
      await pause(30);
      const released = await state(c, h);
      await h.s.send('Input.insertText', { text: 'Window7' });
      await pause(60);
      const typed = await state(c, h);
      await c.key(h, 'Enter');
      const landed = await landedOn(c, 'H1 Window7', h.invokedAt);
      return {
        pass:
          search.search &&
          search.fieldFocused &&
          released.shown &&
          released.search &&
          landed?.active &&
          landed.front &&
          landed.windowId !== c.source.windowId,
        measured: { search, released, typed: typed.selected, landed },
      };
    }),
  );

  // JY-4: pages the overlay cannot host open the list in the popup from the default overlay setting (C-POP-01).
  const focusFrame = async (page) => {
    const s = await page.createCDPSession();
    const at = await page.evaluate(() => {
      const frame = document.querySelector('iframe'),
        f = frame.getBoundingClientRect(),
        i = frame.contentDocument.querySelector('input').getBoundingClientRect();
      return { x: f.x + i.x + i.width / 2, y: f.y + i.y + i.height / 2 };
    });
    await c.click({ s }, at.x, at.y);
    await s.detach();
    return until(() =>
      page.evaluate(() => document.hasFocus() && document.activeElement?.localName === 'iframe' && 'iframe'),
    );
  };
  // Each row's source fact, read from the page itself, proves the source is the kind the row names.
  for (const [kind, url, fact] of [
    ['browser-page', () => 'chrome://version/', (page) => browserPage(page.url(), 'version/') && 'browser page'],
    ['pdf', () => `${c.base}/doc.pdf`, (page) => page.evaluate(() => document.contentType)],
    ['iframe-focus', () => `${c.base}/frame`, focusFrame],
  ])
    add(
      `JY-4-popup-${kind}`,
      `C-POP-01, C-POP-03, C-POP-06: a press on a ${kind} source opens the list in the popup; release lands on the quick target, Source`,
      restoring(async (made) => {
        const tab = await addTab(made, c.source.windowId, url());
        const source = await fact(await c.focus(tab.id));
        const h = await c.open('popup', { tab, listSurface: 'overlay', quickTap: 'flip' }),
          initial = await state(c, h);
        await c.release(h);
        const landed = await settle(
          () => active(c, c.source.windowId),
          (t) => t.id === c.source.id,
        );
        return {
          pass:
            source === { 'browser-page': 'browser page', pdf: 'application/pdf', 'iframe-focus': 'iframe' }[kind] &&
            initial.shown &&
            initial.selected?.title === 'H1 Source' &&
            landed.id === c.source.id,
          measured: { source, initial: initial.selected, landed },
        };
      }),
    );
  add(
    'JY-4-popup-source-navigates',
    'C-POP-12: while the popup list is open the source tab loads another page; the same list stays open and Down, release lands on the row moved to',
    restoring(async (made) => {
      const tab = await addTab(made, c.source.windowId, `${c.base}/?name=Nav`);
      const h = await c.open('popup', { tab, quickTap: 'flip' }),
        before = await state(c, h);
      await c.workerEval(`chrome.tabs.update(${tab.id},{url:${JSON.stringify(`${c.base}/?name=Moved`)}})`);
      const loaded = await settle(
        () => c.workerEval(`chrome.tabs.get(${tab.id})`),
        (t) => t.status === 'complete' && t.title === 'H1 Moved',
        3000,
      );
      await pause(100);
      const after = await state(c, h);
      await c.key(h, 'ArrowDown', HELD.modifier);
      await pause(30);
      const moved = await state(c, h);
      await c.release(h);
      const landed = await settle(
        () => active(c, c.source.windowId),
        (t) => t.title === moved.selected?.title,
      );
      return {
        pass:
          loaded.title === 'H1 Moved' &&
          after.shown &&
          after.rows.length === before.rows.length &&
          moved.selected?.title !== after.selected?.title &&
          landed.title === moved.selected?.title,
        measured: {
          before: before.selected,
          loaded: loaded.title,
          after: after.selected,
          moved: moved.selected,
          landed,
        },
      };
    }),
  );

  // The shipped popup page as Chrome paints it before any script runs, so before results can arrive.
  const prescript = async () => {
    const page = await c.browser.newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.goto(`${c.extensionBase}src/hosts/popup/index.html`);
      return await page.evaluate(() => {
        const r = document.body.getBoundingClientRect();
        return {
          empty: document.body.firstElementChild === null,
          nodes: [...document.body.childNodes].map((n) => [n.nodeName, n.textContent]),
          width: r.width,
          height: r.height,
          background: getComputedStyle(document.documentElement).backgroundColor,
        };
      });
    } finally {
      await page.close();
    }
  };
  add(
    'JY-5-toolbar-first-paint',
    "C-POP-08, KB-11: before any script the popup paints the list frame at list width, dark, though the body holds the whitespace after </body>; the toolbar popup's first frame is never an empty square",
    restoring(async () => {
      const frame = await prescript(),
        h = await c.open('popup', { via: 'toolbar' }),
        first = await c.own(h, '__h1.firstFrame'),
        open = await state(c, h);
      return {
        pass:
          frame.empty &&
          frame.width === open.rect?.width &&
          frame.height >= 100 &&
          frame.background === open.background &&
          first?.width === open.rect.width &&
          first.height >= 100 &&
          first.background === frame.background,
        measured: { frame, first, open: { rect: open.rect, background: open.background } },
      };
    }),
  );
  add(
    'JY-5-toolbar-search-commit',
    'C-POP-09, C-SRCH-15, C-POP-04, C-SRCH-13: the toolbar opens search with the field focused; Backspace edits a query with no results into one that finds Window7; Enter lands there',
    restoring(async () => {
      const h = await c.open('popup', { via: 'toolbar' }),
        opened = await state(c, h);
      await h.s.send('Input.insertText', { text: 'Window7x' });
      await pause(60);
      const none = await state(c, h);
      await c.key(h, 'Backspace');
      const edited = await settle(
        () => state(c, h),
        (s) => s.selected?.title === 'H1 Window7',
      );
      await c.key(h, 'Enter');
      const landed = await landedOn(c, 'H1 Window7', h.invokedAt);
      return {
        pass:
          opened.search &&
          opened.fieldFocused &&
          none.selected === null &&
          edited.selected?.title === 'H1 Window7' &&
          landed?.active &&
          landed.front,
        measured: {
          opened: { search: opened.search, fieldFocused: opened.fieldFocused },
          none: none.selected,
          edited: edited.selected,
          landed,
        },
      };
    }),
  );
  add(
    'JY-5-toolbar-search-esc',
    'C-SRCH-14, C-POP-04: Esc in toolbar search closes the popup and changes nothing',
    async () => {
      const h = await c.open('popup', { via: 'toolbar' });
      await c.key(h, 'Escape');
      const closed = await settle(() => c.popupTargets().length === 0, Boolean);
      await pause(100);
      const after = await active(c, c.source.windowId),
        focusRequests = (await c.focusRequests()).filter((r) => r.wall >= h.invokedAt);
      return {
        pass: closed && after.id === c.source.id && focusRequests.length === 0,
        measured: { closed, after, focusRequests },
      };
    },
  );

  add(
    'JY-6-restart-mid-list',
    'C-SW-02, C-DATA-02: a worker stop closes the open list; the release switches nothing; after the worker wakes, the next tap lands on the quick target from before the stop',
    restoring(async () => {
      await c.focus(c.other.id);
      await c.focus(c.source.id);
      const h = await c.open('overlay', { quickTap: 'flip' }),
        before = await state(c, h);
      await c.stopWorker();
      const atOnce = await settle(
        () => state(c, h),
        (s) => !s.connected,
        1000,
      );
      await c.release(h);
      const closed = await settle(
        () => state(c, h),
        (s) => !s.connected,
        1000,
      );
      // Wakes the worker with a browser event it listens for, a new window; native shortcut wake is M-19.
      const wake = await c.root.send('Target.createTarget', {
        url: `${c.base}/?name=Wake`,
        newWindow: true,
        background: true,
      });
      await c.attachWorker();
      await c.root.send('Target.closeTarget', { targetId: wake.targetId });
      const released = await active(c, c.source.windowId);
      await tap(c.source);
      const landed = await settle(
        () => active(c, c.source.windowId),
        (t) => t.title === before.selected?.title,
      );
      return {
        pass:
          before.shown &&
          !closed.connected &&
          released.id === c.source.id &&
          before.selected?.title === 'H1 Other' &&
          landed.title === 'H1 Other',
        measured: { quickTarget: before.selected, closedAtOnce: !atOnce.connected, closed, released, landed },
      };
    }),
  );

  // Positive controls: each extension context sends one marked request or write, which the recorder must see as the
  // extension's own; then nothing else of the run may be.
  const control = async (expression) => {
    await c.workerEval(expression('worker'));
    await c.own(c.overlay, expression('overlay'));
    const h = await c.open('popup', { via: 'toolbar' });
    await c.own(h, expression('popup'));
    await pause(100);
  };
  const controlled = (rows, text) =>
    Object.fromEntries(
      ['worker', 'overlay', 'popup'].map((k) => [k, rows.some((r) => text(r).endsWith(`${MARK}?${k}`))]),
    );
  add(
    'JY-7-noNetwork',
    'C-SEC-04, C-ICON-01, C-DATA-08: over the run so far, the worker, the popup and the overlay world make no network request',
    async () => {
      await control((k) => `fetch('${CONTROL_URL}?${k}').catch(()=>0)`);
      const own = traffic.requests.filter((r) => traffic.ownRequest(r)),
        controls = controlled(own, (r) => r.url),
        found = own.filter((r) => !r.url.includes(MARK));
      return {
        pass: Object.values(controls).every(Boolean) && found.length === 0,
        measured: { controls, found, recorded: traffic.requests.length },
        artifacts: [e.write('traffic-requests.json', traffic.requests)],
      };
    },
  );
  add(
    'JY-8-storedShape',
    'C-DATA-01, C-ICON-06: every storage change of the run and the final state: session holds only the recents envelope of numbers, local only settings',
    async () => {
      const final = await c.workerEval(
        '(async()=>({session:await chrome.storage.session.get(null),local:await chrome.storage.local.get(null)}))()',
      );
      const changes = traffic.storage.flatMap(({ area, changes: all }) =>
        Object.entries(all).map(([key, { newValue }]) => ({ area, key, newValue })),
      );
      const allowed = ({ area, key, newValue }) =>
        (area === 'session' && key === 'recents' && (newValue === undefined || numbersOnly(newValue))) ||
        (area === 'local' && key === 'settings');
      const found = changes.filter((x) => !allowed(x));
      return {
        pass:
          changes.some((x) => x.area === 'session') &&
          found.length === 0 &&
          Object.keys(final.session).every((k) => k === 'recents') &&
          numbersOnly(final.session.recents ?? 0) &&
          Object.keys(final.local).every((k) => k === 'settings'),
        measured: {
          changes: changes.length,
          found,
          final: { session: Object.keys(final.session), local: Object.keys(final.local) },
        },
        artifacts: [e.write('traffic-storage.json', { changes, final })],
      };
    },
  );
  add(
    'JY-9-silentRelease',
    'C-SET-14: over the run so far, the release build writes nothing to the worker, popup or overlay world console',
    async () => {
      await control((k) => `console.debug('${MARK}?${k}')`);
      const own = traffic.writes.filter((w) => traffic.ownWrite(w)),
        controls = controlled(own, (w) => w.text),
        found = own.filter((w) => !`${w.text} ${w.url ?? ''}`.includes(MARK));
      return {
        pass: Object.values(controls).every(Boolean) && found.length === 0,
        measured: { controls, found, recorded: traffic.writes.length },
        artifacts: [
          e.write('traffic-writes.json', { writes: traffic.writes, contexts: [...traffic.contexts.values()] }),
        ],
      };
    },
  );
}
