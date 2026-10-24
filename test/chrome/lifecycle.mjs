// AC-03, AC-09, AC-20: install and reload (07-tests 2.2).
import path from 'node:path';
import { WELCOME_PAGE } from '../../src/worker/names.ts';
import { Chrome } from './chrome.mjs';
import { Evidence, pause, scrub, until } from './support.mjs';
import { state, active } from './behavior.mjs';

// Install, then an extension reload, in a second disposable browser with its own profile: the welcome tab counted
// before the fixtures close its window, toolbar search order before and after the reload, and the old overlay list's
// page after it. Runs once for the scenarios that read it; the main browser is never reloaded.
class FreshInstall extends Chrome {
  async fixtures() {
    const welcome = () => this.browser.targets().filter((t) => t.url().endsWith(WELCOME_PAGE)).length;
    this.welcomeAtInstall = await until(welcome, 3000).catch(() => 0);
    await pause(300);
    this.welcomeAtInstall = welcome();
    return super.fixtures();
  }
  // Empty query toolbar search rows: recent first, then unused by window and tab bar order (C-SRCH-08).
  async searchOrder() {
    await this.toolbar();
    const target = await until(() => this.popupTarget(), 4000);
    const session = await target.createCDPSession();
    const titles = await until(() =>
      this.eval(
        session,
        `(()=>{const rows=[...document.querySelectorAll('.list [role="option"] .title')].map(t=>t.textContent);return rows.length>3&&rows})()`,
      ),
    );
    await this.closePopup(target);
    await until(() => this.popupTargets().length === 0);
    return titles;
  }
}
function lifecycleOnce(c, e) {
  let run = null;
  return () =>
    (run ??= (async () => {
      const fresh = new FreshInstall(
        { ext: c.ext, cache: c.cache, chrome: c.e.metadata.executable },
        new Evidence(path.join(e.out, 'lifecycle')),
      );
      let seen, clean;
      // Only AC-09 reads the toolbar search order; a failed read fails it alone.
      const failed = (err) => ({ error: scrub(err.message) });
      try {
        await fresh.start();
        seen = { welcomeAtInstall: fresh.welcomeAtInstall, source: fresh.source.id };
        await fresh.focus(fresh.audio.id);
        await fresh.focus(fresh.other.id);
        await fresh.focus();
        seen.before = await fresh.searchOrder().catch(failed);
        const h = await fresh.open('overlay');
        seen.list = await state(fresh, h);
        const worker = (t) => t.type() === 'service_worker' && t.url().startsWith(fresh.extensionBase);
        const old = fresh.browser.targets().find(worker);
        // Loading the same unpacked path again reloads it; chrome.runtime.reload() leaves it disabled in this headless
        // build.
        await fresh.root.send('Extensions.loadUnpacked', { path: fresh.ext });
        const next = await fresh.browser.waitForTarget((t) => worker(t) && t !== old, { timeout: 10000 });
        fresh.worker = await next.createCDPSession();
        await until(() => fresh.workerEval('chrome.commands.onCommand.hasListeners()'), 5000);
        seen.listAfterReload = await until(async () => {
          const x = await state(fresh, fresh.overlay);
          return !x.connected && x;
        }, 2000).catch(() => state(fresh, fresh.overlay));
        await fresh.sourcePage.evaluate(() => (window.__h1Page = []));
        await fresh.key(fresh.overlay, 'ArrowDown');
        seen.pageKeys = await fresh.sourcePage.evaluate(() => window.__h1Page);
        seen.active = (await active(fresh)).id;
        // 05-events section 10: whether the earlier isolated world survives the reload, recorded only.
        seen.oldWorld = await fresh
          .own(fresh.overlay, '(()=>{try{return chrome.runtime.id?"live":"orphan"}catch{return "orphan"}})()')
          .catch((err) => `gone: ${err.message.slice(0, 60)}`);
        await pause(700);
        seen.welcomeAfterReload = fresh.browser.targets().filter((t) => t.url().endsWith(WELCOME_PAGE)).length;
        seen.after = await fresh.searchOrder().catch(failed);
      } finally {
        clean = await fresh.stop();
      }
      if (!clean) throw new Error('Lifecycle browser did not shut down cleanly');
      return seen;
    })());
}

export function lifecycleScenarios(c, e, add) {
  const lifecycle = lifecycleOnce(c, e);
  add(
    'AC-03-welcome-once',
    'A fresh install opens exactly one welcome tab; an extension reload opens none (C-KEY-10)',
    async () => {
      const seen = await lifecycle();
      return {
        pass: seen.welcomeAtInstall === 1 && seen.welcomeAfterReload === 0,
        measured: { atInstall: seen.welcomeAtInstall, afterReload: seen.welcomeAfterReload },
      };
    },
  );
  add(
    'AC-09-reset-on-reload',
    "After an extension reload the recent order is empty and each window's active tab is seeded: the two never active tabs follow all 14 in tab bar order (C-DATA-03, C-REC-09)",
    async () => {
      const { before, after } = await lifecycle();
      if (before.error || after.error) throw new Error(`Toolbar search order unread: ${before.error ?? after.error}`);
      // Audio and Other are the only tabs never active at the reload: unused, they follow every seeded tab in tab
      // bar order (Audio is pinned first), whereas before it Other, used last, came first.
      return {
        pass:
          before.indexOf('H1 Other') < before.indexOf('H1 Audio') &&
          after.length === 16 &&
          after.slice(-2).join() === 'H1 Audio,H1 Other',
        measured: { before, after },
      };
    },
  );
  add(
    'AC-20-orphan-releases-keys',
    'After an extension reload the old list is gone and its page gets its next key press unswallowed; nothing switched (C-SW-06, C-SW-02)',
    async () => {
      const seen = await lifecycle();
      const down = seen.pageKeys.filter((x) => x.key === 'ArrowDown');
      return {
        pass:
          seen.list.shown &&
          !seen.listAfterReload.connected &&
          down.length === 2 &&
          down.every((x) => !x.prevented) &&
          seen.active === seen.source,
        measured: seen,
      };
    },
  );
}
