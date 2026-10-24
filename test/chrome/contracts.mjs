// AC-14 to AC-25: overlay host, list view and icons (07-tests 2.2).
import { SWITCH_COMMAND } from '../../src/worker/names.ts';
import { grantSessions, pause, releaseSessions, until } from './support.mjs';
import { HELD } from './chrome.mjs';
import { MODIFIER_BITS } from '../key-input.ts';
import { state, active, thrown } from './behavior.mjs';
import { withVerifier } from './fixtures.mjs';
import { near } from './look.mjs';
import { pageScenarios } from './pages.mjs';
import { lifecycleScenarios } from './lifecycle.mjs';
import { packageScenarios } from './package.mjs';

// The source page's main world, as page script; a user gesture lets it enter fullscreen.
async function asPage(c, expression) {
  const r = await c.overlay.s.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    userGesture: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
// The list once its cancel fade ends, or as it stands after a second.
const closed = (c, h) => c.waitRemoved(h).catch(() => state(c, h));
const pageInput = (c, value) =>
  c.sourcePage.evaluate((v) => {
    const i = document.querySelector('#page-input');
    if (v !== undefined) {
      i.value = v;
      i.focus();
      i.setSelectionRange(5, 5);
    }
    return { value: i.value, caret: i.selectionStart, focused: document.activeElement === i };
  }, value);

// Extra loaded tabs in the source window for one scenario, removed after it.
async function withTabs(c, urls, fn) {
  const tabs = [];
  try {
    for (const url of urls)
      tabs.push(
        await c.workerEval(
          `chrome.tabs.create({windowId:${c.source.windowId},url:${JSON.stringify(url)},active:false})`,
        ),
      );
    for (const [i, tab] of tabs.entries()) tabs[i] = await c.loaded(tab.id);
    return await fn(tabs);
  } finally {
    if (tabs.length) await c.workerEval(`chrome.tabs.remove(${JSON.stringify(tabs.map((t) => t.id))})`);
  }
}

// A tab whose page sets a 64 px solid PNG icon; the favicon cache records it for the page.
async function withIconTab(c, fn) {
  return withTabs(c, [`${c.base}/?name=Icon`], async ([tab]) => {
    const page = await c.pageFor(tab.id);
    const setIcon = async (colour) => {
      const href = await page.evaluate((fill) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const g = canvas.getContext('2d');
        g.fillStyle = fill;
        g.fillRect(0, 0, 64, 64);
        for (const old of document.querySelectorAll('link[rel=icon]')) old.remove();
        const link = Object.assign(document.createElement('link'), { rel: 'icon', href: canvas.toDataURL() });
        document.head.append(link);
        return link.href;
      }, colour);
      try {
        await until(() => c.workerEval(`chrome.tabs.get(${tab.id}).then(t=>t.favIconUrl===${JSON.stringify(href)})`));
      } catch (error) {
        c.e.write('icon-fixture-error.json', {
          expected: href,
          tab: await c.workerEval(`chrome.tabs.get(${tab.id})`),
          page: await page.evaluate(() => ({
            ready: document.readyState,
            title: document.title,
            icon: document.querySelector('link[rel=icon]')?.href,
          })),
        });
        throw error;
      }
    };
    await setIcon('#e01010');
    return fn({ tab, setIcon });
  });
}

// A synthetic browser fact, as sound-* supplies audible: the bound shortcut the worker and pages read per press.
async function withShortcut(c, shortcut, fn) {
  await c.workerEval(
    `(()=>{__h1.originalCommands=chrome.commands.getAll;chrome.commands.getAll=async()=>[{name:${JSON.stringify(SWITCH_COMMAND)},shortcut:${JSON.stringify(shortcut)},description:''}];return true})()`,
  );
  try {
    return await fn();
  } finally {
    await c.restoreBrowserApis();
  }
}

const SOURCE_TABS = ['H1 Source', 'H1 Audio', 'H1 Other'];

// Row facts the shared inspector leaves out; runs on the panel through CDP pierce.
function rowDetails() {
  const rect = (e) => e?.getBoundingClientRect() ?? null;
  return [...this.querySelectorAll('.list:not(.copy) [role="option"]')].map((row) => {
    const title = row.querySelector('.title'),
      site = row.querySelector('.site'),
      marker = row.querySelector('.marker'),
      icon = row.querySelector('.icon'),
      pin = row.querySelector('svg.pin'),
      sound = row.querySelector('svg.sound');
    return {
      title: title.textContent,
      titleChildren: title.children.length,
      titleX: rect(title).x,
      height: rect(row).height,
      label: row.getAttribute('aria-label'),
      site: site && getComputedStyle(site).display !== 'none' ? { text: site.textContent, x: rect(site).x } : null,
      marker:
        marker && getComputedStyle(marker).display !== 'none'
          ? {
              text: marker.textContent,
              current: marker.classList.contains('current'),
              bg: getComputedStyle(marker).backgroundColor,
            }
          : null,
      icon: icon?.localName === 'img' ? { src: icon.src, width: icon.naturalWidth } : null,
      pin: pin ? rect(pin).x : null,
      sound: sound ? rect(sound).x : null,
      closedMark: !!row.querySelector('svg.closed'),
      selected: row.getAttribute('aria-selected') === 'true',
    };
  });
}
const rows = async (c, h) => (await c.panelCall(h, rowDetails)) ?? [];

// The centre pixel's colour of each row icon, decoded in the host.
function iconColours() {
  return [...this.querySelectorAll('.list [role="option"] img.icon')].map((img) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.getContext('2d').drawImage(img, img.naturalWidth / 2, img.naturalHeight / 2, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = canvas.getContext('2d').getImageData(0, 0, 1, 1).data;
    return { title: img.parentElement.querySelector('.title').textContent, r, g, b };
  });
}

// What a page hit test meets at the panel's centre, ignoring pointer events and inertness: the painted top.
async function topAtCentre(c, h) {
  const panel = await state(c, h);
  // A list already gone has no centre to test; its state is the result, the trace and page log say why it went.
  if (!panel.rect) return { panel: { connected: panel.connected, shown: panel.shown }, inPanel: false };
  const x = Math.round(panel.rect.x + panel.rect.width / 2),
    y = Math.round(panel.rect.y + panel.rect.height / 2);
  const hit = await h.s.send('DOM.getNodeForLocation', { x, y, ignorePointerEventsNone: true });
  const { node } = await h.s.send('DOM.describeNode', { backendNodeId: hit.backendNodeId });
  const { object } = await h.s.send('DOM.resolveNode', { backendNodeId: hit.backendNodeId });
  const r = await h.s.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function(){return !!this.closest?.(".panel")}',
    returnByValue: true,
  });
  return { x, y, node: node.localName, inPanel: r.result.value === true };
}
const DIALOG = `(()=>{const d=document.createElement('dialog');d.id='h1-dialog';d.textContent='Page dialog';d.style.cssText='width:80vw;height:80vh';document.body.append(d);d.showModal();return d.open})()`;
const FULLSCREEN = `document.querySelector('main').requestFullscreen().then(()=>document.fullscreenElement?.localName)`;
// What the page saw from the case's start: input, with whether it carried the held key, focus moves and top layer
// changes.
const PAGE_LOG = `(()=>{if(!window.__h1Layer)for(const type of ['pointermove','pointerdown','keydown','keyup','focus','blur','fullscreenchange','visibilitychange'])addEventListener(type,(e)=>window.__h1Layer.push({at:performance.now(),type,trusted:e.isTrusted,held:!!e.${HELD.flag},key:e.key??null,target:e.target.localName??e.target.nodeName??'window'}),true);window.__h1Layer=[];return true})()`;
async function clearTopLayer(c) {
  await asPage(
    c,
    `(async()=>{if(document.fullscreenElement)await document.exitFullscreen();const d=document.querySelector('#h1-dialog');d?.close();d?.remove();return true})()`,
  );
  await until(() => c.workerEval(`chrome.windows.get(${c.source.windowId}).then(w=>w.state==='normal')`));
}

// WCAG relative luminance contrast, alpha composited over the backdrop (C-A11Y-06).
const channels = (css) => {
  const m = /^rgba?\(([^)]+)\)$/.exec(css);
  if (!m) throw new Error(`Unexpected colour ${css}`);
  const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).map(Number);
  return { r, g, b, a };
};
const over = (top, under) => {
  const t = channels(top),
    u = typeof under === 'string' ? channels(under) : under;
  const mix = (k) => t[k] * t.a + u[k] * (1 - t.a);
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: 1 };
};
const luminance = ({ r, g, b }) => {
  const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};
function textColours() {
  const style = (s) => (s ? getComputedStyle(s) : null);
  const plain = this.querySelector('.list [role="option"]:not([aria-selected="true"])'),
    chosen = this.querySelector('.list [role="option"][aria-selected="true"]');
  return {
    panel: style(this).backgroundColor,
    text: style(plain.querySelector('.title')).color,
    secondary: style(plain.querySelector('.site')).color,
    selected: style(chosen).backgroundColor,
    selectedText: style(chosen.querySelector('.title')).color,
    selectedSecondary: style(chosen.querySelector('.site')).color,
  };
}

export function contractScenarios(c, e, add) {
  // ---- Overlay host

  add(
    'AC-15-ignores-synthetic',
    'Page script key and pointer events (step, Esc, release, row press) never move, commit or cancel the list (C-SEC-01)',
    async () => {
      const h = await c.open('overlay');
      await pause(100);
      const before = await state(c, h);
      const target = await c.sourcePage.evaluate((held) => {
        const key = (type, k, mod) =>
          document.activeElement.dispatchEvent(
            new KeyboardEvent(type, { key: k, [held.flag]: mod, bubbles: true, composed: true, cancelable: true }),
          );
        key('keydown', 'ArrowDown', true);
        key('keyup', 'ArrowDown', true);
        key('keydown', 'Escape', false);
        key('keyup', 'Escape', false);
        key('keyup', held.key, false);
        const x = innerWidth / 2,
          y = innerHeight / 2,
          at = document.elementFromPoint(x, y);
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
          at.dispatchEvent(
            new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, {
              bubbles: true,
              composed: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              button: 0,
            }),
          );
        return at.localName;
      }, HELD);
      await pause(80);
      const after = await state(c, h),
        activeTab = (await active(c)).id;
      return {
        pass:
          after.connected &&
          after.shown &&
          after.selected?.title === before.selected?.title &&
          activeTab === c.source.id,
        measured: { before, after, active: activeTab, pointerTarget: target },
      };
    },
  );

  // AC-16 base rows. Each runs a control after the list closes: the same key edits, scrolls or moves the caret, so
  // the check could fail.
  add(
    'AC-16-keeps-keys-text-field',
    'Backspace while the list is live cancels it and the focused text field keeps its text (C-KEY-06, C-HOLD-10)',
    async () => {
      const h = await c.open('overlay');
      const before = await pageInput(c, 'unchanged');
      await c.key(h, 'Backspace');
      const after = await closed(c, h),
        field = await pageInput(c);
      await c.key(c.overlay, 'Backspace');
      const control = await pageInput(c);
      await pageInput(c, 'unchanged');
      return {
        pass:
          before.focused &&
          !after.connected &&
          field.value === 'unchanged' &&
          (await active(c)).id === c.source.id &&
          control.value !== 'unchanged',
        measured: { before, after, field, control },
      };
    },
  );
  add(
    'AC-16-keeps-keys-page-unscrolled',
    'With the page focused, the list takes Down and the page does not scroll (C-KEY-06)',
    async () => {
      const h = await c.open('overlay');
      await c.sourcePage.evaluate(() => {
        document.activeElement.blur();
        scrollTo(0, 0);
      });
      await c.key(h, 'ArrowDown');
      await pause(60);
      const after = await state(c, h),
        scroll = await c.sourcePage.evaluate(() => scrollY);
      await c.cancel(h);
      await c.sourcePage.evaluate(() => document.activeElement.blur());
      await c.key(c.overlay, 'ArrowDown');
      const control = await until(() => c.sourcePage.evaluate(() => scrollY), 1000).catch(() => 0);
      await c.sourcePage.evaluate(() => {
        scrollTo(0, 0);
      });
      return {
        pass: after.shown && after.selected?.title !== 'H1 Source' && scroll === 0 && control > 0,
        measured: { after, scroll, control },
      };
    },
  );
  // A binding held on the modifier that moves the caret a word with Left: Option on macOS, Ctrl elsewhere.
  const word =
    process.platform === 'darwin'
      ? { shortcut: '⌥Q', modifier: MODIFIER_BITS.alt }
      : { shortcut: 'Ctrl+Q', modifier: MODIFIER_BITS.ctrl };
  add(
    'AC-16-keeps-keys-caret',
    'With an Alt binding (Ctrl off macOS, where Alt+Left moves no caret), its key+Left shows another window and moves no caret in the focused text field (C-KEY-06, C-KEY-03, C-WIN-04)',
    () =>
      withShortcut(c, word.shortcut, async () => {
        const h = await c.open('overlay');
        await pageInput(c, 'unchanged');
        const before = await state(c, h);
        await c.key(h, 'ArrowLeft', word.modifier);
        await pause(60);
        const after = await state(c, h),
          field = await pageInput(c);
        await c.cancel(h);
        await pageInput(c, 'unchanged');
        await c.key(c.overlay, 'ArrowLeft', word.modifier);
        const control = await pageInput(c);
        const shown = (x) => x.strip?.cells.findIndex((cell) => cell.selected);
        return {
          pass: after.shown && shown(after) !== shown(before) && field.caret === 5 && control.caret !== 5,
          measured: { before, after, field, control },
        };
      }),
  );
  add(
    'AC-16-keeps-keys-missed-release-esc',
    'Flip to last tab: Esc after a missed release cancels, switches nothing and never reaches the page (KB-07, C-HOLD-12, C-KEY-06)',
    async () => {
      const h = await c.open('overlay', { quickTap: 'flip' });
      await c.key(h, 'Escape');
      const after = await closed(c, h),
        page = await c.sourcePage.evaluate(() => window.__h1Page);
      return {
        pass:
          !after.connected &&
          (await active(c)).id === c.source.id &&
          !page.some((x) => x.type === 'keydown' && x.key === 'Escape'),
        measured: { after, page },
      };
    },
  );

  // Search by the held F over the page, or by the toolbar in the popup, then a query that leaves H1 Other highlighted.
  const searchOther = async (flavor) => {
    const h = flavor === 'popup' ? await c.open('popup', { via: 'toolbar' }) : await c.open('overlay');
    if (flavor === 'overlay') {
      await c.key(h, 'f', HELD.modifier);
      await pause(110);
    }
    const all = await state(c, h);
    await h.s.send('Input.insertText', { text: 'Other' });
    const typed = await until(async () => {
      const s = await state(c, h);
      return s.selected?.title === 'H1 Other' && s.rows.length < all.rows.length && s;
    }).catch(() => state(c, h));
    return { h, all, typed };
  };
  add(
    'AC-16-search-esc-clears',
    'In overlay search, Esc with text empties the field and lists every tab again, focus stays in the field and the page sees no key; Esc again cancels and switches nothing (C-SRCH-14, C-KEY-06)',
    async () => {
      const { h, all, typed } = await searchOther('overlay');
      await c.sourcePage.evaluate(() => (window.__h1Page = []));
      await c.key(h, 'Escape');
      const cleared = await until(async () => {
        const s = await state(c, h);
        return s.rows?.length === all.rows.length && s;
      }).catch(() => state(c, h));
      const page = await c.sourcePage.evaluate(() => window.__h1Page);
      await c.key(h, 'Escape');
      const after = await closed(c, h);
      return {
        pass:
          all.search &&
          typed.selected?.title === 'H1 Other' &&
          cleared.connected &&
          cleared.search &&
          cleared.fieldFocused &&
          cleared.fieldText === '' &&
          cleared.rows.length === all.rows.length &&
          page.length === 0 &&
          !after.connected &&
          (await active(c)).id === c.source.id,
        measured: {
          rows: { all: all.rows.length, typed: typed.rows?.length, cleared: cleared.rows?.length },
          cleared: { connected: cleared.connected, fieldFocused: cleared.fieldFocused, fieldText: cleared.fieldText },
          page,
          after: { connected: after.connected },
        },
      };
    },
  );
  add(
    'AC-16-search-command-overlay',
    'The Search tabs command over a web page opens the overlay in search with the field focused and the host editable; typed keys reach only the field, never the page or its focused input (C-KEY-12, C-SRCH-05)',
    async () => {
      const h = await c.open('overlay', { via: 'search' });
      const opened = await state(c, h);
      await c.sourcePage.evaluate(() => (window.__h1Page = []));
      await c.type(h, 'Other');
      const typed = await until(async () => {
        const s = await state(c, h);
        return s.selected?.title === 'H1 Other' && s;
      }).catch(() => state(c, h));
      const page = await c.sourcePage.evaluate(() => window.__h1Page),
        input = await pageInput(c);
      await c.cancel(h);
      return {
        pass:
          opened.search &&
          opened.fieldFocused &&
          opened.hostEditable === 'plaintext-only' &&
          typed.fieldText === 'Other' &&
          typed.selected?.title === 'H1 Other' &&
          page.length === 0 &&
          input.value === 'unchanged' &&
          (await active(c)).id === c.source.id,
        measured: {
          opened: { search: opened.search, fieldFocused: opened.fieldFocused, hostEditable: opened.hostEditable },
          typed: { fieldText: typed.fieldText, selected: typed.selected?.title },
          page,
          input,
        },
      };
    },
  );
  // The copy key's modifier, whatever the held key: Cmd on macOS, Ctrl elsewhere (C-SRCH-26).
  const copyModifier = process.platform === 'darwin' ? MODIFIER_BITS.meta : MODIFIER_BITS.ctrl;
  for (const flavor of ['overlay', 'popup'])
    add(
      `AC-16-copy-${flavor}`,
      `In ${flavor} search, Cmd+C (Ctrl+C off macOS) copies the highlighted address with no clipboard permission; the field keeps focus, text and caret, and the list stays; read back on a separate verifier origin (C-SRCH-26, probe p-clip)`,
      () =>
        withVerifier(c, async (verifier) => {
          const sentinel = `lilotab-sentinel-${flavor}`;
          const seeded = (await verifier.seed(sentinel)) === sentinel;
          const { h, typed } = await searchOther(flavor);
          await c.key(h, 'c', copyModifier);
          await pause(60);
          const after = await state(c, h);
          const expected = (await c.workerEval(`chrome.tabs.get(${c.other.id})`)).url;
          await c.cancel(h);
          const clipboard = await verifier.read();
          const clipboardWrite = await c.workerEval(`chrome.permissions.contains({permissions:['clipboardWrite']})`);
          return {
            pass:
              seeded &&
              typed.selected?.title === 'H1 Other' &&
              clipboard === expected &&
              after.connected &&
              after.fieldFocused &&
              after.fieldText === typed.fieldText &&
              JSON.stringify(after.fieldSelection) === JSON.stringify(typed.fieldSelection) &&
              after.notice === '' &&
              !clipboardWrite,
            measured: {
              seeded,
              copied: clipboard === expected,
              sentinelKept: clipboard === sentinel,
              typed: { selected: typed.selected?.title, fieldText: typed.fieldText, selection: typed.fieldSelection },
              after: {
                connected: after.connected,
                fieldFocused: after.fieldFocused,
                fieldText: after.fieldText,
                selection: after.fieldSelection,
                notice: after.notice,
              },
              clipboardWrite,
            },
          };
        }),
    );

  add(
    'AC-17-closed-root',
    'Page script, hooking attachShadow and DOM mutations before the press, finds no title, address or icon address of the search list (C-HOLD-20, C-ICON-02)',
    () =>
      withIconTab(c, async () => {
        await c.sourcePage.evaluate(() => {
          const native = Element.prototype.attachShadow;
          window.__h1Roots = [];
          window.__h1Restore = () => {
            Element.prototype.attachShadow = native;
            window.__h1Watch.disconnect();
          };
          Element.prototype.attachShadow = function (options) {
            const r = native.call(this, options);
            window.__h1Roots.push(r);
            return r;
          };
          window.__h1Watch = new MutationObserver((list) => {
            for (const m of list) for (const n of m.addedNodes) window.__h1Roots.push(n.shadowRoot ?? null);
          });
          window.__h1Watch.observe(document.documentElement, { childList: true, subtree: true });
        });
        try {
          const h = await c.open('overlay');
          await c.key(h, 'f', HELD.modifier);
          await pause(150);
          const shown = await rows(c, h);
          const found = await c.sourcePage.evaluate(() => {
            const roots = [...window.__h1Roots, ...[...document.querySelectorAll('*')].map((n) => n.shadowRoot)];
            const text = [
              document.documentElement.outerHTML,
              document.documentElement.innerText,
              ...roots.map((r) => (r ? r.innerHTML : '')),
            ].join('\n');
            return {
              reachableRoots: roots.filter(Boolean).length,
              title: text.includes('H1 Other'),
              address: text.includes('?name=Other'),
              icon: text.includes('data:image'),
            };
          });
          return {
            pass:
              shown.some((r) => r.title === 'H1 Other') &&
              shown.some((r) => r.icon?.src.startsWith('data:image/png')) &&
              found.reachableRoots === 0 &&
              !found.title &&
              !found.address &&
              !found.icon,
            measured: { shown: shown.map((r) => ({ title: r.title, site: r.site, icon: !!r.icon })), found },
          };
        } finally {
          await c.sourcePage.evaluate(() => window.__h1Restore());
        }
      }),
  );

  add('AC-18-text-only', 'A title holding markup renders as literal text (C-SEC-03)', () => {
    const markup = '<b id="h1-markup">Bold</b><img src="x">';
    return withTabs(c, [`${c.base}/?name=${encodeURIComponent(markup)}`], async () => {
      const h = await c.open('overlay');
      const row = (await rows(c, h)).find((r) => r.title === `H1 ${markup}`);
      return { pass: row?.titleChildren === 0, measured: { row: row ?? null } };
    });
  });

  // AC-19 (C-HOLD-18): page top layer content open before the press, so the list shows over it; cleared after the
  // case. The press sends no held key down, so a page input without it infers release and opens the list (C-HOLD-12,
  // T-68), and a blur then cancels it (C-HOLD-11, T-30); the page log records both. A thrown check records the host
  // before the cleanup resets it.
  const withTopLayer = async (layer, fn) => {
    try {
      let entered;
      await asPage(c, PAGE_LOG);
      const h = await c.open('overlay', { beforePress: async () => (entered = await asPage(c, layer)) });
      return await fn(entered, h);
    } catch (err) {
      const failed = await thrown(c, err);
      failed.measured.page = await asPage(c, 'window.__h1Layer');
      return failed;
    } finally {
      await c.reset();
      await clearTopLayer(c);
    }
  };
  for (const [id, expected, layer, present] of [
    [
      'AC-19-above-dialog',
      'With a page modal dialog open at the press, the list paints topmost at its centre (C-HOLD-18)',
      DIALOG,
      `!!document.querySelector('#h1-dialog')?.open`,
    ],
    [
      'AC-19-above-fullscreen',
      'With a page element fullscreen at the press, the list paints topmost at its centre (C-HOLD-18)',
      FULLSCREEN,
      `document.fullscreenElement?.localName ?? null`,
    ],
  ]) {
    add(id, expected, () =>
      withTopLayer(layer, async (entered, h) => {
        await pause(150);
        const top = await topAtCentre(c, h),
          open = await asPage(c, present);
        return {
          pass: !!entered && open === entered && top.inPanel,
          measured: { entered, open, top, page: await asPage(c, 'window.__h1Layer') },
          artifacts: [await c.shot(h, `${id}.png`)],
        };
      }),
    );
  }
  // ---- List view

  add('AC-22-rows-pinned-mark', 'Only the pinned row shows the pinned mark (C-HOLD-16)', async () => {
    const h = await c.open('overlay'),
      shown = await rows(c, h);
    return {
      pass: shown.find((r) => r.title === 'H1 Audio')?.pin > 0 && shown.filter((r) => r.pin !== null).length === 1,
      measured: { shown },
    };
  });
  add('AC-22-rows-search-host', 'Each search row shows its host after the title (C-SRCH-21)', async () => {
    const h = await c.open('overlay');
    await c.key(h, 'f', HELD.modifier);
    await pause(120);
    const shown = await rows(c, h);
    return {
      pass: shown.length > 1 && shown.every((r) => r.site?.text === '127.0.0.1' && r.site.x > r.titleX),
      measured: { shown },
    };
  });
  add(
    'AC-22-rows-window-markers',
    'Search rows of one window share a marker and the current window marker looks different (C-SRCH-07)',
    async () => {
      const h = await c.open('overlay');
      await c.key(h, 'f', HELD.modifier);
      await pause(120);
      const shown = await rows(c, h);
      const current = shown.filter((r) => SOURCE_TABS.includes(r.title)),
        others = shown.filter((r) => !SOURCE_TABS.includes(r.title));
      return {
        pass:
          current.length === SOURCE_TABS.length &&
          current.every((r) => r.marker?.text === '1' && r.marker.current) &&
          others.length > 1 &&
          others.every((r) => r.marker && !r.marker.current && r.marker.bg !== current[0].marker.bg) &&
          new Set(others.map((r) => r.marker.text)).size === others.length,
        measured: { shown },
      };
    },
  );
  add('AC-22-rows-no-results', 'A search with no match shows "No matching tabs" (C-SRCH-16)', async () => {
    const h = await c.open('overlay');
    await c.key(h, 'f', HELD.modifier);
    await pause(120);
    await h.s.send('Input.insertText', { text: 'zzqx' });
    const empty = await until(() =>
      c.panelCall(h, function () {
        const e = this.querySelector('.empty');
        return e?.textContent && getComputedStyle(e).display !== 'none' ? e.textContent : null;
      }),
    );
    return { pass: empty === 'No matching tabs' && (await rows(c, h)).length === 0, measured: { empty } };
  });
  add(
    'AC-22-rows-closed-restore',
    'With Include recently closed tabs On and the sessions permission held, a query lists a tab closed meanwhile with the closed mark in the marker place and "Recently closed" in its name; Enter reopens it and closes the list (C-SRCH-27, C-SRCH-28)',
    async () => {
      const url = `${c.base}/?name=Gone`;
      try {
        const granted = await grantSessions(c);
        const gone = await c.loaded(
          (
            await c.workerEval(
              `chrome.tabs.create({windowId:${c.source.windowId},url:${JSON.stringify(url)},active:false})`,
            )
          ).id,
        );
        await c.workerEval(`chrome.tabs.remove(${gone.id})`);
        const h = await c.open('overlay', { via: 'search', closedTabs: 'on' });
        await h.s.send('Input.insertText', { text: 'Gone' });
        const [row] = await until(async () => {
          const shown = await rows(c, h);
          return shown.length === 1 && shown;
        }).catch(() => rows(c, h));
        await c.key(h, 'Enter');
        const after = await closed(c, h);
        const reopened = await until(() =>
          c.workerEval(`chrome.tabs.query({url:${JSON.stringify(url)}}).then(t=>t.length>0&&t.map(x=>x.id))`),
        ).catch(() => []);
        await c.workerEval(`chrome.tabs.remove(${JSON.stringify(reopened)})`).catch(() => {});
        return {
          pass:
            granted &&
            row?.closedMark &&
            !row.marker &&
            row.selected &&
            row.label === 'H1 Gone, Recently closed' &&
            !after.connected &&
            reopened.length === 1,
          measured: {
            granted,
            row: row && { label: row.label, closedMark: row.closedMark, marker: row.marker, selected: row.selected },
            after: { connected: after.connected },
            reopened: reopened.length,
          },
        };
      } finally {
        await releaseSessions(c);
      }
    },
  );
  add(
    'AC-22-rows-icon-moves-nothing',
    'A row with its icon and rows with the placeholder keep the same title position and height (C-ICON-04)',
    () =>
      withIconTab(c, async () => {
        const h = await c.open('overlay');
        await pause(120); // past the open motion's scale
        const shown = await until(async () => {
          const x = await rows(c, h);
          return x.some((r) => r.icon) && x;
        });
        return {
          pass:
            shown.some((r) => !r.icon) &&
            shown.every((r) => near(r.titleX, shown[0].titleX, 0.5) && near(r.height, shown[0].height, 0.5)),
          measured: { shown },
        };
      }),
  );
  add(
    'AC-22-rows-sound-after-pin',
    'A pinned tab playing sound shows the speaker after the pinned mark (C-HOLD-25)',
    async () => {
      await c.audibleFixture(true);
      try {
        const h = await c.open('overlay'),
          row = (await rows(c, h)).find((r) => r.title === 'H1 Audio');
        return { pass: row?.pin > 0 && row.sound > row.pin, measured: { row: row ?? null } };
      } finally {
        await c.audibleFixture(false);
      }
    },
  );

  add(
    'AC-23-semantics-roles',
    'Listbox of options with the highlighted row selected; strip tab list with the shown window selected, also after a step and a window change (C-A11Y-01, C-WIN-03)',
    async () => {
      const h = await c.open('overlay');
      const read = () =>
        c.panelCall(h, function () {
          const list = this.querySelector('.list:not(.copy)'),
            strip = this.querySelector('.strip');
          const options = [...list.children];
          return {
            listRole: list.getAttribute('role'),
            optionRoles: [...new Set(options.map((o) => o.getAttribute('role')))],
            selected: options.filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.id),
            active: list.getAttribute('aria-activedescendant'),
            stripRole: strip.getAttribute('role'),
            cellRoles: [...new Set([...strip.children].map((x) => x.getAttribute('role')))],
            cells: [...strip.children].flatMap((x, i) => (x.getAttribute('aria-selected') === 'true' ? [i] : [])),
          };
        });
      const start = await read();
      await c.key(h, 'ArrowDown', HELD.modifier);
      await pause(40);
      const stepped = await read();
      await c.key(h, 'ArrowRight', HELD.modifier);
      await pause(40);
      const moved = await read();
      const holds = (x, cell) =>
        x.listRole === 'listbox' &&
        x.optionRoles.join() === 'option' &&
        x.selected.length === 1 &&
        x.active === x.selected[0] &&
        x.stripRole === 'tablist' &&
        x.cellRoles.join() === 'tab' &&
        x.cells.join() === String(cell);
      return {
        pass: holds(start, 0) && holds(stepped, 0) && stepped.selected[0] !== start.selected[0] && holds(moved, 1),
        measured: { start, stepped, moved },
      };
    },
  );
  add(
    'AC-23-semantics-names',
    'Row names hold the title, "Playing sound" right after it, the pinned state and, in search, the window (C-A11Y-02, C-HOLD-25)',
    async () => {
      await c.audibleFixture(true);
      try {
        const h = await c.open('overlay'),
          hold = await rows(c, h);
        await c.key(h, 'f', HELD.modifier);
        await pause(120);
        const search = await rows(c, h);
        const byTitle = (x, t) => x.find((r) => r.title === t)?.label;
        return {
          pass:
            byTitle(hold, 'H1 Audio') === 'H1 Audio, Playing sound, Pinned' &&
            byTitle(hold, 'H1 Other') === 'H1 Other' &&
            byTitle(search, 'H1 Audio') === 'H1 Audio, Playing sound, Pinned, This window' &&
            search
              .filter((r) => !SOURCE_TABS.includes(r.title))
              .every((r) => r.label.startsWith(`${r.title}, Window `)),
          measured: { hold, search },
        };
      } finally {
        await c.audibleFixture(false);
      }
    },
  );

  // AC-24 runs on the open list (released), where pointer input never infers a release.
  const longList = (fn) =>
    withTabs(
      c,
      Array.from({ length: 22 }, () => 'about:blank'),
      fn,
    );
  const listScroll = (h) =>
    c.panelCall(h, function () {
      const list = this.querySelector('.list:not(.copy)'),
        sel = list.querySelector('[aria-selected="true"]');
      const box = list.getBoundingClientRect(),
        row = sel?.getBoundingClientRect();
      return {
        scrollTop: list.scrollTop,
        max: list.scrollHeight - list.clientHeight,
        scrollbarWidth: getComputedStyle(list).scrollbarWidth,
        gutter: list.offsetWidth - list.clientWidth,
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
        selectedInView: row ? row.top >= box.top - 0.5 && row.bottom <= box.bottom + 0.5 : null,
      };
    });
  async function wheel(h, at, deltaY) {
    await h.s.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: at.rect.x + at.rect.width / 2,
      y: at.rect.y + at.rect.height / 2,
      deltaX: 0,
      deltaY,
    });
    await pause(120);
    return { list: await listScroll(h), page: await c.sourcePage.evaluate(() => scrollY) };
  }
  const openList = async () => {
    const h = await c.open('overlay');
    await c.release(h);
    await c.sourcePage.evaluate(() => {
      scrollTo(0, 0);
    });
    return h;
  };
  add(
    'AC-24-scroll-highlight-in-view',
    'Stepping past the last visible row keeps the highlight in view (C-HOLD-19)',
    () =>
      longList(async () => {
        const h = await openList(),
          seen = [];
        for (let i = 0; i < 24; i++) {
          await c.key(h, 'ArrowDown');
          seen.push(await listScroll(h));
        }
        return {
          pass: seen.every((x) => x.selectedInView) && seen.some((x) => x.scrollTop > 0),
          measured: { seen },
        };
      }),
  );
  add('AC-24-scroll-no-scrollbar', 'A list longer than its box shows no scrollbar (KB-05, C-HOLD-19)', () =>
    longList(async () => {
      const h = await openList(),
        x = await listScroll(h);
      return { pass: x.max > 0 && x.scrollbarWidth === 'none' && x.gutter === 0, measured: x };
    }),
  );
  add('AC-24-scroll-wheel-list', 'Wheel over a long list scrolls the list and never the page (KB-06, C-HOLD-19)', () =>
    longList(async () => {
      const h = await openList(),
        start = await listScroll(h),
        after = await wheel(h, start, 200);
      return { pass: start.max > 0 && after.list.scrollTop > 0 && after.page === 0, measured: { start, after } };
    }),
  );
  add('AC-24-scroll-wheel-end', 'Wheel at the end of a long list never scrolls the page (KB-08, C-HOLD-19)', () =>
    longList(async () => {
      const h = await openList(),
        start = await listScroll(h),
        end = await wheel(h, start, 4000),
        beyond = await wheel(h, start, 400);
      return {
        pass: end.list.scrollTop === end.list.max && end.list.max > 0 && beyond.page === 0 && end.page === 0,
        measured: { start, end, beyond },
      };
    }),
  );
  add(
    'AC-24-scroll-wheel-short',
    'Wheel over a short list that cannot scroll never scrolls the page (KB-08, C-HOLD-19)',
    async () => {
      const h = await openList(),
        start = await listScroll(h),
        after = await wheel(h, start, 400);
      const pageCanScroll = await c.sourcePage.evaluate(() => document.documentElement.scrollHeight > innerHeight);
      return { pass: start.max === 0 && pageCanScroll && after.page === 0, measured: { start, after, pageCanScroll } };
    },
  );

  // AC-25 rows the 9-* scenarios lack: contrast and Large text size.
  for (const flavor of ['overlay', 'popup'])
    for (const theme of ['dark', 'light'])
      add(
        `AC-25-contrast-${flavor}-${theme}`,
        `${theme} ${flavor}: text, secondary text and the highlighted row reach 4.5:1${flavor === 'overlay' ? ' over a white and a black page' : ''} (C-A11Y-06, C-HOLD-26)`,
        async () => {
          const h = await c.open(flavor, { theme }),
            colours = await c.panelCall(h, textColours);
          const backdrops = flavor === 'overlay' ? ['rgb(255, 255, 255)', 'rgb(0, 0, 0)'] : ['rgb(0, 0, 0)'];
          const ratios = backdrops.flatMap((page) => {
            const panel = over(colours.panel, page);
            return [
              { page, pair: 'text', ratio: contrast(over(colours.text, panel), panel) },
              { page, pair: 'secondary', ratio: contrast(over(colours.secondary, panel), panel) },
            ];
          });
          const selected = over(colours.selected, 'rgb(0, 0, 0)');
          ratios.push(
            { pair: 'selectedText', ratio: contrast(over(colours.selectedText, selected), selected) },
            { pair: 'selectedSecondary', ratio: contrast(over(colours.selectedSecondary, selected), selected) },
          );
          return { pass: ratios.every((r) => r.ratio >= 4.5), measured: { colours, ratios } };
        },
      );
  add('AC-25-large-text', 'Text size Large grows the row text (C-A11Y-05, C-SET-09)', async () => {
    const size = (h) =>
      c.panelCall(h, function () {
        return parseFloat(getComputedStyle(this.querySelector('.list [role="option"] .title')).fontSize);
      });
    const normal = await size(await c.open('overlay'));
    await c.reset();
    const large = await size(await c.open('overlay', { textSize: 'large' }));
    return { pass: large > normal, measured: { normal, large } };
  });

  // ---- Icons

  add(
    'AC-14-icons-first-list',
    "The first list shows a tab's icon as PNG data from the favicon cache at 32 px from a 64 px page icon (C-ICON-01, C-ICON-05)",
    () =>
      withIconTab(c, async () => {
        const h = await c.open('overlay');
        const row = await until(async () => (await rows(c, h)).find((r) => r.title === 'H1 Icon' && r.icon));
        return {
          pass: row.icon.src.startsWith('data:image/png;base64,') && row.icon.width === 32,
          measured: { row },
        };
      }),
  );
  add('AC-14-icons-refresh', 'A page that changed its icon shows the new icon in the next list (C-ICON-07)', () =>
    withIconTab(c, async ({ setIcon }) => {
      const colour = async () => {
        const h = await c.open('overlay');
        return until(async () => (await c.panelCall(h, iconColours)).find((x) => x.title === 'H1 Icon'));
      };
      const first = await colour();
      await c.reset();
      await setIcon('#10a010');
      const next = await colour();
      return { pass: first.r > 200 && first.g < 60 && next.g > 120 && next.r < 60, measured: { first, next } };
    }),
  );

  pageScenarios(c, e, add);
  lifecycleScenarios(c, e, add);
  packageScenarios(c, e, add);
}
