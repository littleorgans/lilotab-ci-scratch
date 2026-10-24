import fs from 'node:fs';
import http from 'node:http';
import { SWITCH_COMMAND } from '../../src/worker/names.ts';
import { abandoned, pause, until } from './support.mjs';

// A one page PDF with a valid cross reference table, served for the popup fallback journey.
function pdfFixture() {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = body.length;
    body += `${i + 1} 0 obj${o}endobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${body}trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
}
// A page whose focus can sit inside an iframe.
const frameFixture =
  '<!doctype html><meta charset="utf-8"><title>H1 Frame</title><iframe srcdoc="<input id=inner>" style="width:400px;height:120px"></iframe>';
export async function fixtureServer() {
  const fixture = fs.readFileSync(new URL('./fixture.html', import.meta.url));
  const wav = Buffer.alloc(44 + 48000 * 2);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 48000; i++)
    wav.writeInt16LE(Math.round(1500 * Math.sin((i * 2 * Math.PI * 220) / 48000)), 44 + i * 2);
  const routes = {
    '/tone.wav': ['audio/wav', wav],
    '/doc.pdf': ['application/pdf', pdfFixture()],
    '/frame': ['text/html', frameFixture],
  };
  const server = http.createServer((req, res) => {
    const [type, body] = routes[new URL(req.url, 'http://fixture').pathname] ?? ['text/html', fixture];
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', type);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// The clipboard verifier of probe p-clip: a page on its own loopback origin, the only origin granted clipboard access,
// in a popup window, which the list never lists (C-WIN-14). seed writes a sentinel and reads it back; read reads the
// clipboard once the verifier has focus again.
export async function withVerifier(c, fn) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><title>Clipboard verifier</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let window;
  try {
    await c.root.send('Browser.grantPermissions', {
      origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    window = await c.workerEval(
      `chrome.windows.create({url:${JSON.stringify(`${origin}/verifier`)},type:'popup',focused:false})`,
    );
    const page = await c.pageFor(window.tabs[0].id);
    const focus = async () => {
      await c.workerEval(`chrome.windows.update(${window.id},{focused:true})`);
      await page.bringToFront();
      await until(() => page.evaluate(() => document.hasFocus()));
    };
    return await fn({
      async seed(sentinel) {
        await focus();
        await page.evaluate((text) => navigator.clipboard.writeText(text), sentinel);
        return page.evaluate(() => navigator.clipboard.readText());
      },
      async read() {
        await focus();
        return page.evaluate(() => navigator.clipboard.readText());
      },
    });
  } finally {
    if (window) await c.workerEval(`chrome.windows.remove(${window.id})`).catch(() => {});
    // A socket the browser opened ahead of a request would hold close open until Node's request timeout.
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
}

// Tabs beyond the fixtures and any explicitly retained initial tabs, including tabs in a scenario's new window.
async function strayTabs(c) {
  return (await c.workerEval('chrome.tabs.query({})')).filter((t) => !c.fixtureTabs.has(t.id));
}
// The fixture's recent order in the source window: Source, then Audio, then Other.
async function recentOrder(c) {
  for (const id of [c.other.id, c.audio.id, c.source.id]) await c.focus(id);
}

export async function createFixtures(c) {
  c.stage = 'fixture windows';
  const initial = await c.workerEval('chrome.windows.getAll()');
  c.windows = [];
  // Each window and tab is created once Vivaldi's UI shows the one before.
  for (let i = 0; i < 14; i++) {
    const w = await c.workerEval(
      `chrome.windows.create({url:${JSON.stringify(c.base + '/?name=' + (i === 0 ? 'Source' : 'Window' + i))},focused:true,type:'normal',width:800,height:600,left:0,top:0})`,
    );
    await c.vivaldiHosts(w.tabs[0]);
    c.windows.push(w);
  }
  c.source = c.windows[0].tabs[0];
  c.other = await c.workerEval(
    `chrome.tabs.create({windowId:${c.source.windowId},url:${JSON.stringify(c.base + '/?name=Other')},active:false})`,
  );
  await c.vivaldiHosts(c.other);
  // Pinned by update: Vivaldi ignores pinned at creation.
  c.audio = await c.workerEval(
    `chrome.tabs.create({windowId:${c.source.windowId},url:${JSON.stringify(c.base + '/?name=Audio')},active:false}).then((t)=>chrome.tabs.update(t.id,{pinned:true}))`,
  );
  await c.vivaldiHosts(c.audio);
  // Tabs the harness did not open, such as the welcome tab, would add rows to every list.
  let strays = 0;
  const close = async (tabs) => {
    strays += tabs.length;
    if (tabs.length)
      await Promise.race([c.workerEval(`chrome.tabs.remove(${JSON.stringify(tabs.map((t) => t.id))})`), pause(2000)]);
  };
  // An initial window closes down to one tab first: Brave resolves the removal of a window of several tabs but keeps it
  // open, and closing that window's last tab then crashes the browser. Opera never settles the removal headless. A
  // window still open after 2 s stays and is recorded.
  c.retainedWindows = [];
  for (const w of initial) {
    await close((await c.workerEval(`chrome.tabs.query({windowId:${w.id}})`)).slice(1));
    await Promise.race([c.workerEval(`chrome.windows.remove(${w.id})`), pause(2000)]);
    const gone = () => c.workerEval(`chrome.windows.get(${w.id}).then(()=>false,()=>true)`);
    if (!(await until(gone, 2000).catch(() => false))) c.retainedWindows.push(w.id);
  }
  // A retained browser window's existing tabs also belong to the baseline; later extras in any window do not.
  const retained = (await c.workerEval('chrome.tabs.query({})')).filter((t) => c.retainedWindows.includes(t.windowId));
  c.fixtureTabs = new Set([
    ...c.windows.map((w) => w.tabs[0].id),
    c.other.id,
    c.audio.id,
    ...retained.map((t) => t.id),
  ]);
  await close(await strayTabs(c));
  await pause(350);
  c.stage = 'window focus';
  await recentOrder(c);
  c.sourcePage = await c.pageFor(c.source.id);
  c.stage = 'toolbar action';
  await c.grant();
  c.stage = 'overlay world';
  await c.prepareOverlay();
  await c.workerEval(`chrome.windows.update(${c.source.windowId},{width:1440,height:900})`);
  c.e.write('fixtures.json', {
    windows: c.windows.length,
    tabs: 16,
    source: c.source.id,
    audio: await c.workerEval(
      `(async()=>{const t=await chrome.tabs.get(${c.audio.id});return {audible:t.audible,muted:t.mutedInfo?.muted}})()`,
    ),
    outputMutedByBrowserFlag: true,
    retainedWindows: c.retainedWindows,
    strayTabsClosed: strays,
  });
}

// What one scenario made: temporary tabs, synthetic browser facts, a changed recent order and the sessions grant. The
// scenario wrapper cleans after the whole scenario body; on timeout the bound's restore cleans in recovery mode, which
// also covers state outside the ledger. A helper that needs cleanup before its scenario ends calls clean itself.
// Abandoned work never reads or writes the ledger: the next scenario owns it once recovery has run.
export class ScenarioFixtures {
  #tabs = new Set();
  #faked = false;
  #reorders = false;
  #sessions = false;
  constructor(c) {
    this.c = c;
  }
  #live(name) {
    if (abandoned()) throw new Error(`Refused ${name}: its scenario was cut off by the bound`);
  }
  // Loaded tabs at urls in windowId, not active.
  async tabs(urls, windowId = this.c.source.windowId) {
    this.#live('tabs');
    const tabs = [];
    for (const url of urls) {
      const tab = await this.c.workerEval(
        `chrome.tabs.create({windowId:${windowId},url:${JSON.stringify(url)},active:false})`,
      );
      this.#live('tabs');
      this.#tabs.add(tab.id);
      tabs.push(tab);
    }
    for (const [i, tab] of tabs.entries()) tabs[i] = await this.c.loaded(tab.id);
    return tabs;
  }
  // A synthetic browser fact in the worker: api[name] becomes replacement(native). Restore puts each native back, last
  // first, so stacked overrides restore correctly.
  #fake(api, name, replacement) {
    this.#live(`${api}.${name}`);
    this.#faked = true;
    return this.c.workerEval(
      `(()=>{const native=${api}.${name};(__h1.originals??=[]).push([${api},${JSON.stringify(name)},native]);${api}.${name}=(${replacement})(native);return true})()`,
    );
  }
  // chrome.windows.getAll reports audible true for the Audio fixture only.
  audible() {
    return this.#fake(
      'chrome.windows',
      'getAll',
      `(native)=>async(...args)=>(await native(...args)).map(w=>({...w,tabs:w.tabs?.map(t=>({...t,audible:t.id===${this.c.audio.id}}))}))`,
    );
  }
  // chrome.commands.getAll reports the switch command bound to text, as the worker and pages read it per press.
  shortcut(text) {
    return this.#fake(
      'chrome.commands',
      'getAll',
      `()=>async()=>[{name:${JSON.stringify(SWITCH_COMMAND)},shortcut:${JSON.stringify(text)},description:''}]`,
    );
  }
  // This scenario's clean restores the fixture's recent order.
  reorders() {
    this.#live('reorders');
    this.#reorders = true;
  }
  // Whether Chrome granted the optional sessions permission, requested from the options page; headless Chrome for
  // Testing grants an optional permission requested in a user gesture without a prompt.
  async sessions() {
    this.#live('sessions');
    this.#sessions = true;
    const options = await this.c.browser.newPage();
    try {
      await options.goto(this.c.extensionBase + this.c.manifest.options_ui.page);
      const s = await options.createCDPSession();
      const asked = await s.send('Runtime.evaluate', {
        expression: `chrome.permissions.request({permissions:['sessions']})`,
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
      });
      return asked.result?.value === true;
    } finally {
      await options.close();
    }
  }
  // Undoes the ledger. Recovery also restores every fact, closes hosts and every stray tab, releases the sessions
  // permission, reloads the source page (a dialog, fullscreen or prototype hook left by abandoned work) and restores
  // the recent order; it returns what reset forced and how many tabs it removed. Each entry clears once its step
  // succeeds, so a failed clean repeats at the next one. An empty ledger sends nothing.
  async clean({ recover = false } = {}) {
    this.#live('clean');
    const c = this.c;
    if (recover || this.#faked) {
      await c.workerEval(
        `(()=>{const o=__h1.originals??[];while(o.length){const [api,name,native]=o.pop();api[name]=native}return true})()`,
      );
      this.#live('clean');
      this.#faked = false;
    }
    const forced = recover ? await c.reset() : {};
    let removed = [];
    if (recover || this.#tabs.size) {
      removed = (await strayTabs(c)).map((t) => t.id).filter((id) => recover || this.#tabs.has(id));
      if (removed.length) await c.workerEval(`chrome.tabs.remove(${JSON.stringify(removed)})`);
      this.#live('clean');
      this.#tabs.clear();
    }
    if (recover || this.#sessions) {
      await c.workerEval(`chrome.permissions.remove({permissions:['sessions']})`);
      this.#live('clean');
      this.#sessions = false;
    }
    if (recover) {
      await c.sourcePage.reload();
      await c.prepareOverlay();
    }
    if (recover || this.#reorders) {
      await recentOrder(c);
      this.#live('clean');
      this.#reorders = false;
    }
    return { ...forced, ...(removed.length ? { tabs: removed.length } : {}) };
  }
}
