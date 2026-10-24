// AC-26 to AC-29: extension pages (07-tests 2.2).
import { SWITCH_COMMAND, WELCOME_PAGE } from '../../src/worker/names.ts';
import { browserPage, pause, until } from './support.mjs';

// An extension page in a new tab, optionally over stored settings, a synthetic bound shortcut and a held sessions
// permission; closed after.
async function onPage(c, file, fn, { settings, shortcut, sessions } = {}) {
  if (settings) await c.workerEval(`chrome.storage.local.set({settings:${JSON.stringify(settings)}})`);
  const page = await c.browser.newPage();
  try {
    // Granted, as Chrome's prompt would leave it; a harness page cannot answer the prompt. Removal is recorded.
    if (sessions)
      await page.evaluateOnNewDocument(() => {
        const permissions = globalThis.chrome.permissions;
        let held = true;
        permissions.contains = () => Promise.resolve(held);
        permissions.remove = () => {
          held = false;
          globalThis.__sessionsRemoved = true;
          return Promise.resolve(true);
        };
      });
    if (shortcut !== undefined)
      await page.evaluateOnNewDocument(
        (name, s) => {
          globalThis.chrome.commands.getAll = () => Promise.resolve([{ name, shortcut: s, description: '' }]);
        },
        SWITCH_COMMAND,
        shortcut,
      );
    await page.goto(c.extensionBase + file);
    await page.waitForSelector('main');
    return await fn(page);
  } finally {
    await page.close();
  }
}
const optionsPage = (c) => c.manifest.options_ui.page;
const shortcutsPage = (t) => browserPage(t.url(), 'extensions/shortcuts');
const press = async (page, text) => {
  const handle = await page.evaluateHandle(
    (t) => [...document.querySelectorAll('button')].find((b) => b.textContent === t),
    text,
  );
  await handle.asElement().click();
};
const sorted = (list) => [...list].sort((a, b) => a.localeCompare(b)).join('|');

export function pageScenarios(c, e, add) {
  const shortcutState = (page) =>
    page.waitForFunction(() => {
      const hint = document.querySelector('.hint');
      if (!hint || hint.firstElementChild?.hidden !== false) return null;
      const problem = document.querySelector('.problem');
      const note = hint.parentElement.querySelector('.hint ~ .hint');
      return {
        shortcut: hint.textContent,
        problem: problem && !problem.hidden ? problem.textContent : null,
        note: note && !note.hidden ? note.textContent : null,
        change: [...document.querySelectorAll('button')].some(
          (b) => b.textContent === 'Change shortcut' && !b.disabled,
        ),
        usage: [...document.querySelectorAll('.usage li')].map((li) => li.textContent),
      };
    });
  // The bound state's note names Opera and Vivaldi on macOS only (C-KEY-13).
  const MAC_NOTE =
    process.platform === 'darwin'
      ? 'In Opera and Vivaldi, Command+E opens a browser feature. If the shortcut does nothing there, choose another one, such as Control+S, with Change shortcut.'
      : null;
  const TAKEN_NOTE =
    'Your browser or another extension may already use the default. Choose a shortcut with Change shortcut.';
  const SHORTCUT_STATES = [
    ['bound', undefined, (s) => s.shortcut.startsWith(c.shortcutText) && s.problem === null && s.note === MAC_NOTE],
    ['none', '', (s) => s.shortcut.startsWith('No shortcut set') && s.problem === null && s.note === TAKEN_NOTE],
    [
      'no-modifier',
      'F5',
      (s) => s.shortcut.startsWith('F5') && s.problem === 'This shortcut needs Cmd, Ctrl or Alt' && s.note === null,
    ],
  ];
  for (const [where, file] of [
    ['settings', () => optionsPage(c)],
    ['welcome', () => WELCOME_PAGE],
  ])
    for (const [name, shortcut, shows] of SHORTCUT_STATES) {
      if (where === 'welcome' && name === 'no-modifier') continue; // same shared block and usage branch as below
      add(
        `AC-26-shortcut-${where}-${name}`,
        `The ${where} page shows the ${name} shortcut state with Change shortcut${where === 'welcome' ? ', and usage lines only for a bound shortcut' : ''} (C-SET-01, C-KEY-09, C-KEY-10, C-KEY-11, C-KEY-13)`,
        () =>
          onPage(
            c,
            file(),
            async (page) => {
              const s = await (await shortcutState(page)).jsonValue();
              const usage = where === 'settings' || s.usage.length === (name === 'bound' ? 3 : 1);
              return { pass: shows(s) && s.change && usage, measured: s };
            },
            { shortcut },
          ),
      );
    }
  // The binding as installed, before any harness substitute: a clash with a browser shortcut leaves it unset. Chromium
  // never auto assigns a suggested key that is a browser accelerator, so this fails where a browser keeps the default
  // (Opera on macOS keeps Command+E); the pages then show the C-KEY-09 note.
  add('AC-26-shortcut-default', 'The switch command installs with its suggested shortcut set (C-KEY-01)', () => ({
    pass: !!c.installedShortcut,
    measured: { installed: c.installedShortcut, simulated: c.e.metadata.shortcutSimulated ?? null },
  }));
  add(
    'AC-26-shortcut-change',
    'Change shortcut opens chrome://extensions/shortcuts in a new tab (C-SET-17, C-SET-01)',
    () =>
      onPage(c, optionsPage(c), async (page) => {
        await shortcutState(page);
        await press(page, 'Change shortcut');
        const opened = await c.browser.waitForTarget(shortcutsPage, {
          timeout: 3000,
        });
        const tab = await opened.page();
        await tab?.close();
        return { pass: !!tab && !page.isClosed(), measured: { opened: opened.url() } };
      }),
  );

  const DEFAULTS = {
    quickTap: 'flip',
    quickScope: 'window',
    holdDelayMs: '50',
    tabOrder: 'recent',
    listSurface: 'overlay',
    closedTabs: 'off',
    tabCountBadge: 'off',
    theme: 'dark',
    textSize: 'default',
    reduceMotion: 'system',
  };
  const controls = (page) =>
    page.evaluate(() => ({
      checked: Object.fromEntries(
        [...document.querySelectorAll('input[type=radio]:checked')].map((i) => [i.name, i.value]),
      ),
      disabled: [...document.querySelectorAll('fieldset')].map((f) => f.disabled),
      labels: [...document.querySelectorAll('fieldset')].map(
        (f) => document.getElementById(f.getAttribute('aria-labelledby'))?.textContent,
      ),
      status: [...document.querySelectorAll('.status')].map((s) => s.textContent).filter(Boolean),
      failedUnder: [...document.querySelectorAll('.group > .status')]
        .filter((s) => s.textContent)
        .map((s) => s.closest('.group').id),
      index: [...document.querySelectorAll('nav.index a')].map((a) => ({
        label: a.textContent,
        target: document.querySelector(a.getAttribute('href'))?.querySelector('h2')?.textContent ?? null,
      })),
      notice: [...document.querySelectorAll('.notice')].filter((n) => !n.hidden).map((n) => n.textContent),
      buttons: Object.fromEntries([...document.querySelectorAll('button')].map((b) => [b.textContent, !b.disabled])),
    }));
  const choose = async (page, field, value) => (await page.$(`input[name="${field}"][value="${value}"]`)).click();
  const loaded = (page, field = 'theme') =>
    page.waitForFunction((f) => document.querySelector(`input[name="${f}"]:checked`), {}, field);

  add(
    'AC-27-options-save-local',
    'A changed setting persists in local storage across a reload; nothing is written to sync (C-DATA-04, C-SET-06)',
    () =>
      onPage(
        c,
        optionsPage(c),
        async (page) => {
          await loaded(page);
          await choose(page, 'theme', 'light');
          const stored = await until(() =>
            page.evaluate(() =>
              globalThis.chrome.storage.local.get('settings').then((s) => s.settings?.theme === 'light' && s),
            ),
          );
          const sync = await page.evaluate(() => globalThis.chrome.storage.sync.get(null));
          await page.reload();
          await loaded(page);
          const after = await controls(page);
          return {
            pass: after.checked.theme === 'light' && Object.keys(sync).length === 0,
            measured: { stored, sync, after },
          };
        },
        { settings: { version: 1 } },
      ),
  );
  add(
    'AC-27-options-restore-defaults',
    'Restore defaults restores every setting to its default, kept after a reload, and gives back the sessions permission (C-SET-11, C-SET-29)',
    () =>
      onPage(
        c,
        optionsPage(c),
        async (page) => {
          await loaded(page);
          const before = await controls(page);
          await press(page, 'Restore defaults');
          await page.waitForFunction(() => document.querySelector('input[name="theme"]:checked')?.value === 'dark');
          await pause(100);
          const removed = await page.evaluate(() => globalThis.__sessionsRemoved === true);
          await page.reload();
          await loaded(page);
          const after = await controls(page);
          return {
            pass:
              Object.entries(DEFAULTS).every(([k, v]) => before.checked[k] !== v) &&
              Object.entries(DEFAULTS).every(([k, v]) => after.checked[k] === v) &&
              removed,
            measured: { before, after, removed },
          };
        },
        {
          sessions: true,
          settings: {
            version: 1,
            quickTap: 'list',
            quickScope: 'all',
            holdDelayMs: 200,
            tabOrder: 'window',
            listSurface: 'popup',
            closedTabs: 'on',
            tabCountBadge: 'on',
            theme: 'light',
            textSize: 'large',
            reduceMotion: 'always',
          },
        },
      ),
  );
  add(
    'AC-27-options-save-failed',
    'A rejected save restores the control and says "Could not save the setting. Try again." under the group whose save failed (C-SET-18)',
    () =>
      onPage(
        c,
        optionsPage(c),
        async (page) => {
          await loaded(page);
          // The storage write fails as the browser would report it; the page's own rules handle the rest.
          await page.evaluate(() => {
            globalThis.chrome.storage.local.set = () => Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
          });
          await choose(page, 'theme', 'light');
          const after = await until(async () => {
            const x = await controls(page);
            return x.status.length > 0 && x.checked.theme === 'dark' && x;
          }).catch(() => controls(page));
          return {
            pass:
              after.checked.theme === 'dark' &&
              after.status.includes('Could not save the setting. Try again.') &&
              after.failedUnder.join() === 'appearance',
            measured: after,
          };
        },
        { settings: { version: 1 } },
      ),
  );
  add(
    'AC-27-options-settings-offered',
    'The page offers exactly the contract settings: no strip or pinned setting, one search setting; the side index lists the eight groups in order, each naming its group (C-SET-15, C-SET-16, C-WIN-13, C-SET-26)',
    () =>
      onPage(
        c,
        optionsPage(c),
        async (page) => {
          await loaded(page);
          const { labels, index } = await controls(page);
          const contract = [
            'Quick tap',
            'Quick tap switches within',
            'Hold delay',
            'Tab order',
            'Show the list',
            'Include recently closed tabs',
            'Tab count badge',
            'Theme',
            'Text size',
            'Reduce motion',
          ];
          const groups = [
            'Shortcuts',
            'Quick tap',
            'Tab list',
            'Search',
            'Toolbar icon',
            'Appearance',
            'Privacy and data',
            'About',
          ];
          return {
            pass:
              sorted(labels) === sorted(contract) &&
              index.map((i) => i.label).join('|') === groups.join('|') &&
              index.every((i) => i.target === i.label),
            measured: { labels, index },
          };
        },
        { settings: { version: 1 } },
      ),
  );

  add(
    'AC-28-options-newer-locked',
    'Settings from a newer version disable every setting control and show the update notice; Change shortcut and Clear now still work (C-DATA-10)',
    () =>
      onPage(
        c,
        optionsPage(c),
        async (page) => {
          await loaded(page);
          await page.waitForFunction(() => [...document.querySelectorAll('.notice')].some((n) => !n.hidden));
          const locked = await controls(page);
          await press(page, 'Clear now');
          await page.waitForFunction(() =>
            [...document.querySelectorAll('.status')].some((s) => s.textContent === 'Recent tab history cleared.'),
          );
          await press(page, 'Change shortcut');
          const opened = await c.browser.waitForTarget(shortcutsPage, {
            timeout: 3000,
          });
          await (await opened.page())?.close();
          return {
            pass:
              locked.disabled.length === 10 &&
              locked.disabled.every(Boolean) &&
              !locked.buttons['Restore defaults'] &&
              locked.notice.join() ===
                'These settings were saved by a newer version of Lilotab. Update Lilotab to change them.',
            measured: { locked, cleared: true, opened: opened.url() },
          };
        },
        { settings: { version: 2, theme: 'light' } },
      ),
  );

  // AC-29: the worker's real answer, then replies the worker can give or fail to give, at the page's message call.
  const NOT_CLEARED = 'Recent tab history was not cleared. Try again.';
  for (const [name, reply, expected] of [
    ['ok', null, 'Recent tab history cleared.'],
    ['not-ok', '() => Promise.resolve({ v: 1, t: "cleared", ok: false })', NOT_CLEARED],
    ['rejected', '() => Promise.reject(new Error("Could not establish connection"))', NOT_CLEARED],
    ['silent', '() => new Promise(() => {})', NOT_CLEARED],
  ])
    add(
      `AC-29-options-clear-${name}`,
      `Clear now with ${name === 'ok' ? 'the worker answering ok' : `a ${name} answer`} says "${expected}" and enables the button again${name === 'silent' ? ' at its 5 s timer' : ''} (C-DATA-09)`,
      () =>
        onPage(
          c,
          optionsPage(c),
          async (page) => {
            await loaded(page);
            if (reply) await page.evaluate(`chrome.runtime.sendMessage = ${reply}`);
            await press(page, 'Clear now');
            // Silence: the page's own 5 s answer timer, found and fired through the probe as 10-ping-idle does.
            const timer =
              name === 'silent'
                ? await page.evaluate(() => {
                    const t = globalThis.__h1.timeouts.find((x) => x.active && x.ms === 5000);
                    t?.call();
                    return t ? { ms: t.ms } : null;
                  })
                : null;
            const status = await (
              await page.waitForFunction(
                () => {
                  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Clear now');
                  const s = b.closest('.row').querySelector('.status').textContent;
                  return !b.disabled && s !== 'Clearing' && s;
                },
                { timeout: 3000 },
              )
            ).jsonValue();
            return { pass: status === expected && (name !== 'silent' || !!timer), measured: { status, timer } };
          },
          { settings: { version: 1 } },
        ),
    );
}
