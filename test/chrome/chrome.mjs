import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import diagnostics from 'node:diagnostics_channel';
import puppeteer from 'puppeteer-core';
import { Browser, install } from '@puppeteer/browsers';
import { abandoned, pause, until, scrub, within } from './support.mjs';
import { fixtureServer, createFixtures } from './fixtures.mjs';
import { installProbe, inspectPanel, readProbe } from './probe.mjs';
import { SWITCH_COMMAND } from '../../src/worker/names.ts';

export const CHROME_BUILD = '156.0.8078.47';
// The switch command's suggested shortcut on this platform (manifest.config.ts: Command+E on macOS, Ctrl+Shift+E
// elsewhere) as the pages show it, and its held key as CDP and DOM key input.
const mac = process.platform === 'darwin';
const SHORTCUT_TEXT = mac ? 'Cmd+E' : 'Ctrl+Shift+E';
export const HELD = mac
  ? { key: 'Meta', code: 'MetaLeft', keyCode: 91, modifier: 4, flag: 'metaKey' }
  : { key: 'Control', code: 'ControlLeft', keyCode: 17, modifier: 2, flag: 'ctrlKey' };
// Assigned where the browser leaves the suggested shortcut unset (Edge owns Ctrl+Shift+E): the same held key with a
// key the Chromium browsers leave free.
const SIMULATED_SHORTCUT = 'Ctrl+Shift+9';
// Vivaldi's bundled UI extension and its browser window page.
const VIVALDI_EXTENSION = 'chrome-extension://mpognobbkildjkofajifpdfhcoklimli/';
const VIVALDI_UI = `${VIVALDI_EXTENSION}window.html`;
const probeSource = `(${installProbe.toString()})()`;
// Opera's extension renderer, which also runs the worker, crashes when an action popup opens within a few hundred ms of
// the last one closing (up to 250 ms on Windows); its worker target then stays listed and never answers. In Opera no
// toolbar press or command comes sooner than this after a popup closes; other browsers keep fast reopens.
const POPUP_SETTLE_MS = 1000;
// Harness profile processes as `pid ppid command` on Windows, which has no pgrep or ps; PowerShell filters by the
// profile path, read from the environment to avoid quoting it.
const windowsProfileProcesses = (profile) =>
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:HARNESS_PROFILE) } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }',
    ],
    { encoding: 'utf8', env: { ...process.env, HARNESS_PROFILE: profile } },
  )
    .split(/\r?\n/)
    .filter(Boolean);
export class Chrome {
  constructor(options, evidence) {
    Object.assign(this, options);
    this.e = evidence;
    this.problems = [];
    this.instrumented = new Set();
    this.observers = [];
    this.shortcutText = SHORTCUT_TEXT;
  }
  // Called with every session the harness attaches (page, popup or worker) before its domains are enabled.
  observe(fn) {
    this.observers.push(fn);
  }
  async notify(session, kind) {
    for (const fn of this.observers) await fn(session, kind);
  }
  // `stage` names the setup step in progress, so a failed setup reports where it stopped.
  async start() {
    this.stage = 'launch';
    // Fetches the pinned Chrome for Testing into the cache once; later runs reuse it offline.
    const installed = this.chrome
      ? { executablePath: this.chrome }
      : await install({ browser: Browser.CHROME, buildId: CHROME_BUILD, cacheDir: this.cache });
    if (!fs.existsSync(installed.executablePath)) throw new Error('Chrome executable missing; check --chrome');
    // Opera reports a Chrome/ version, so its executable name identifies it.
    this.opera = path.basename(installed.executablePath).toLowerCase().startsWith('opera');
    this.server = await fixtureServer();
    this.base = `http://127.0.0.1:${this.server.address().port}`;
    this.profile = fs.mkdtempSync(path.join(this.e.out, 'profile-'));
    // browser.log takes the browser's stderr and exit from spawn, so a browser that dies during launch still leaves
    // its output, exit code and signal. The launch's first child process is the browser; its stdio exists once spawn
    // returns.
    const log = path.join(this.e.out, 'browser.log');
    const capture = ({ process: child }) => {
      queueMicrotask(() => {
        diagnostics.unsubscribe('child_process', capture);
        child.stderr?.on('data', (s) => {
          fs.appendFileSync(log, scrub(s));
        });
        child.once('exit', (code, signal) => {
          fs.appendFileSync(log, `browser exited: code ${code}, signal ${signal}\n`);
        });
      });
    };
    diagnostics.subscribe('child_process', capture);
    this.browser = await puppeteer.launch({
      executablePath: installed.executablePath,
      userDataDir: this.profile,
      headless: true,
      enableExtensions: true,
      pipe: true,
      defaultViewport: null,
      args: [
        // Lets the pipe connection load the build (Extensions.loadUnpacked); branded Chrome ignores --load-extension.
        '--enable-unsafe-extension-debugging',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--screen-info={1920x1080}',
        '--window-size=1440,900',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        // Puppeteer's defaults too, stated so no browser reaches the OS keychain or password store.
        '--use-mock-keychain',
        '--password-store=basic',
      ],
    });
    this.pid = this.browser.process().pid;
    this.root = await this.browser.target().createCDPSession();
    // Every protocol command, any session's, passes the connection's _rawSend (puppeteer internal); one from work the
    // scenario bound abandoned is refused, so that work cannot act on a later scenario's state when it wakes.
    const connection = this.root.connection(),
      send = connection._rawSend;
    if (typeof send !== 'function') throw new Error('Puppeteer connection has no _rawSend to refuse abandoned work');
    connection._rawSend = function (...args) {
      if (abandoned()) return Promise.reject(new Error(`Refused ${args[1]}: its scenario was cut off by the bound`));
      return send.apply(this, args);
    };
    this.pageBoots = [];
    const autoAttach = {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'tab' }, { exclude: true }],
    };
    const watch = (parent) =>
      parent.on('Target.attachedToTarget', async ({ sessionId, targetInfo, waitingForDebugger }) => {
        const session = this.root.connection().session(sessionId);
        if (!session) return;
        const attachedAt = Date.now();
        // Chrome exposes a new extension popup as other before it becomes page.
        const probed = targetInfo.type === 'page' || targetInfo.type === 'other';
        try {
          if (targetInfo.type === 'tab') {
            watch(session);
            await session.send('Target.setAutoAttach', {
              ...autoAttach,
              filter: [{ type: 'page' }, { exclude: true }],
            });
          }
          if (probed) {
            const defaults = this.popupDefaults ?? { freeze: [], osReduce: false, theme: 'dark' };
            const source = `${probeSource};__h1.freeze=${JSON.stringify(defaults.freeze)};`;
            // A paused target may answer nothing until it runs: Edge's PDF guest view also arrives here as other, and
            // has no renderer before then. So every command goes out at once with the resume last, and the session
            // keeps their order: the probe and media are in place before the target's first script, no answer is
            // awaited while it is paused, and a popup spends no round trip of the worker's 500 ms host deadline
            // (C-POP-05). `setupMs` records when the answers arrived.
            const [, , , , , observed] = await Promise.all([
              this.notify(session, 'page'),
              session.send('Page.enable'),
              session.send('Runtime.enable'),
              this.emulate(session, defaults.osReduce, defaults.theme),
              session.send('Page.addScriptToEvaluateOnNewDocument', { source }),
              session.send('Runtime.evaluate', {
                expression: `${source};({ready:document.readyState,panelAlreadyMounted:!!document.querySelector('.panel'),at:performance.now()})`,
                returnByValue: true,
              }),
              session.send('Runtime.runIfWaitingForDebugger'),
            ]);
            this.pageBoots.push({
              targetId: targetInfo.targetId,
              type: targetInfo.type,
              waitingForDebugger,
              setupMs: Date.now() - attachedAt,
              ...observed.result.value,
            });
            this.instrumented.add(targetInfo.targetId);
          }
        } catch (e) {
          this.problems.push({ kind: 'pageProbe', error: scrub(e.message) });
        } finally {
          if (!probed) await session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
        }
      });
    watch(this.root);
    await this.root.send('Target.setAutoAttach', autoAttach);
    this.popupRoot = await this.browser.target().createCDPSession();
    watch(this.popupRoot);
    await this.popupRoot.send('Target.setAutoAttach', {
      ...autoAttach,
      filter: [{ type: 'other' }, { exclude: true }],
    });
    if (this.opera)
      this.browser.on('targetdestroyed', (t) => {
        if (this.isPopup(t)) this.popupClosedAt = Date.now();
      });
    this.manifest = JSON.parse(fs.readFileSync(path.join(this.ext, 'manifest.json')));
    this.stage = 'extension load';
    // Installs the build after the watchers attach, so its welcome tab is observed. --disable-extensions-except would
    // keep it disabled in branded Chrome; the fresh profile has no other unpacked extension.
    await this.root.send('Extensions.loadUnpacked', { path: this.ext });
    const callbacks = await this.attachWorker();
    const inventory = [];
    const collect = (dir) => {
      for (const item of fs
        .readdirSync(path.join(this.ext, dir), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) collect(file);
        else if (item.isFile())
          inventory.push({
            file,
            sha256: createHash('sha256')
              .update(fs.readFileSync(path.join(this.ext, file)))
              .digest('hex'),
          });
      }
    };
    collect('');
    this.e.write('build-files.json', inventory);
    this.e.metadata = {
      node: process.version,
      browser: await this.browser.version(),
      executable: installed.executablePath,
      extension: this.ext,
      manifestSha256: createHash('sha256')
        .update(fs.readFileSync(path.join(this.ext, 'manifest.json')))
        .digest('hex'),
      buildSha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'),
      commandCallbacks: callbacks,
      pid: this.pid,
      started: new Date().toISOString(),
    };
    this.e.limits.push(
      'Shortcut invocation calls the exact registered worker callback through CDP. Native OS shortcut routing is unverified. All key and pointer input uses CDP trusted browser events; no OS input.',
    );
    this.e.limits.push(
      'Reduce motion uses CDP Emulation.setEmulatedMedia, including changes while open. OS preference UI and OS event delivery are unverified.',
    );
    this.e.limits.push(
      'Motion durations and easing come from actual Animation effects and captured CSS animation starts. Specified WAAPI effects are paused for deterministic mid animation inspection, then resumed. Wall clock animation scheduling under OS load is unverified.',
    );
    this.e.limits.push(
      'Ping checks invoke the registered 20 second interval callback in the host world and compare real worker timer handles and due times. Natural timer scheduling and MV3 suspension after five minutes are unverified.',
    );
    this.e.limits.push(
      'Glass evidence includes computed backdrop filter and owner screenshots over a busy local page. Blur appearance and GPU performance need owner assessment; no video performance claim.',
    );
    this.e.limits.push(
      'The browser is muted. Natural audio reported audible false. Speaker cases supply audible true for the Audio fixture at chrome.windows.getAll in the worker, restoring the API after each case. Natural audible detection is unverified; adapter to snapshot to protocol to rendered icon is exercised with that synthetic browser fact.',
    );
    this.e.limits.push(
      'A targeted source page press can leave a real headless toolbar popup focused. That case minimizes and restores the source browser window to generate native window blur, and labels the observation as a substitute. Native OS toolbar outside dismissal remains unverified.',
    );
    this.vivaldi = this.browser.targets().some((t) => t.url().startsWith(VIVALDI_EXTENSION));
    await this.simulateShortcut();
    await this.fixtures();
  }
  // An unset switch shortcut makes every command a no op (C-KEY-11). The harness then assigns SIMULATED_SHORTCUT
  // through the API the browser's shortcuts page uses, as a user would, and labels the run; AC-26-shortcut-default
  // still reports the binding as installed.
  async simulateShortcut() {
    const read = () =>
      this.workerEval(
        `chrome.commands.getAll().then(l=>l.find(x=>x.name===${JSON.stringify(SWITCH_COMMAND)})?.shortcut??'')`,
      );
    this.installedShortcut = await read();
    if (this.installedShortcut) return;
    const page = await this.browser.newPage();
    const binding = { extensionId: this.extensionId, commandName: SWITCH_COMMAND, keybinding: SIMULATED_SHORTCUT };
    this.e.metadata.shortcutSimulated = 'failed';
    try {
      await page.goto('chrome://extensions/shortcuts');
      await page.evaluate((b) => globalThis.chrome.developerPrivate.updateExtensionCommand(b), binding);
      await until(read, 2000);
      this.shortcutText = this.e.metadata.shortcutSimulated = SIMULATED_SHORTCUT;
    } catch (err) {
      this.problems.push({ kind: 'shortcutSimulation', error: scrub(err.message) });
    } finally {
      await page.close();
    }
  }
  // The loaded extension's worker, by its manifest script until its id is known; a browser can run bundled extension
  // workers beside it (Vivaldi does).
  ownWorker(t) {
    if (t.type() !== 'service_worker' || !t.url().startsWith('chrome-extension:')) return false;
    const url = new URL(t.url());
    return this.extensionId
      ? url.hostname === this.extensionId
      : url.pathname === `/${this.manifest.background.service_worker}`;
  }
  // Attaches the harness to the running extension worker: probe, port observer and the one command listener.
  async attachWorker() {
    const target = await this.browser.waitForTarget((t) => this.ownWorker(t), { timeout: 15000 });
    this.extensionId = new URL(target.url()).hostname;
    this.extensionBase = `chrome-extension://${this.extensionId}/`;
    this.worker = await target.createCDPSession();
    await this.notify(this.worker, 'worker');
    await this.worker.send('Runtime.enable');
    this.worker.on('Runtime.exceptionThrown', (e) =>
      this.problems.push({ kind: 'workerException', detail: scrub(e.exceptionDetails.text) }),
    );
    await until(
      () => this.workerEval('typeof chrome!=="undefined" && !!chrome.commands?.onCommand?.hasListeners()'),
      10000,
    );
    await this.workerEval(probeSource);
    // The observer runs after the product's onConnect listener, which disconnects a refused port (05 4.3); adding a
    // listener to that port throws into the event dispatch, a worker console entry JY-9 would count. It records the
    // port in `closedPorts` instead.
    await this.workerEval(`(()=>{
      const p=__h1;p.messages=[];p.closedPorts=[];
      const observe=port=>{try{port.onMessage.addListener(m=>{if(m.t==='input'||m.t==='ready')p.messages.push({at:performance.now(),wall:Date.now(),t:m.t,input:m.input??null})})}catch{p.closedPorts.push({wall:Date.now()})}return port};
      const connect=chrome.tabs.connect.bind(chrome.tabs);chrome.tabs.connect=(...args)=>observe(connect(...args));
      chrome.runtime.onConnect.addListener(observe);
      p.focusRequests=[];const update=chrome.windows.update.bind(chrome.windows);
      chrome.windows.update=(id,info,...rest)=>{if(info?.focused)p.focusRequests.push({wall:Date.now(),windowId:id});return update(id,info,...rest)};
      return true;
    })()`);
    const proto = await this.worker.send('Runtime.evaluate', { expression: 'Function.prototype' });
    const funcs = await this.worker.send('Runtime.queryObjects', {
      prototypeObjectId: proto.result.objectId,
      objectGroup: 'h1-command',
    });
    const listeners = await this.worker.send('Runtime.callFunctionOn', {
      objectId: funcs.objects.objectId,
      functionDeclaration:
        'function(){return this.filter(f=>{try{return chrome.commands.onCommand.hasListener(f)}catch{return false}})}',
    });
    const props = await this.worker.send('Runtime.getProperties', {
      objectId: listeners.result.objectId,
      ownProperties: true,
    });
    const callbacks = props.result.filter((x) => /^\d+$/.test(x.name));
    if (callbacks.length !== 1)
      throw new Error(`Expected one registered command listener; observed ${callbacks.length}`);
    this.commandListener = callbacks[0].value.objectId;
    return callbacks.length;
  }
  // Stops the extension worker as Chrome does when idle: close its target and detach every session from it.
  async stopWorker() {
    const target = this.browser.targets().find((t) => this.ownWorker(t));
    await this.worker.detach().catch(() => {});
    await (await target.worker()).close();
    await until(() => !this.browser.targets().some((t) => this.ownWorker(t)), 5000);
  }
  async eval(session, expression, contextId) {
    const r = await session.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId ? { contextId } : {}),
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  workerEval(expression) {
    return this.eval(this.worker, expression);
  }
  async command(tabId = this.source.id) {
    await this.popupSettled();
    const r = await this.worker.send('Runtime.callFunctionOn', {
      objectId: this.commandListener,
      functionDeclaration:
        'async function(id){const tab=await chrome.tabs.get(id);const wall=Date.now();this("flip-tab",tab);return {wall}}',
      arguments: [{ value: tabId }],
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  fixtures() {
    return createFixtures(this);
  }
  // Tabs beyond the fixtures and any explicitly retained initial tabs, including tabs in a scenario's new window.
  async strayTabs() {
    return (await this.workerEval('chrome.tabs.query({})')).filter((t) => !this.fixtureTabs.has(t.id));
  }
  // What a cut off scenario's cleanup would have done: no list or popup, no stray tab, the recent order. Returns what
  // it removed.
  async restore() {
    await this.restoreBrowserApis();
    const forced = await this.reset(),
      strays = (await this.strayTabs()).map((t) => t.id);
    if (strays.length) await this.workerEval(`chrome.tabs.remove(${JSON.stringify(strays)})`);
    // Source page cases can leave a dialog, fullscreen or prototype hook behind their abandoned finally block.
    await this.sourcePage.reload();
    await this.prepareOverlay();
    await this.recentOrder();
    return { ...forced, ...(strays.length ? { tabs: strays.length } : {}) };
  }
  // The fixture's recent order in the source window: Source, then Audio, then Other.
  async recentOrder() {
    for (const id of [this.other.id, this.audio.id, this.source.id]) await this.focus(id);
  }
  // A new tab reports an empty url until its navigation commits, so each poll rereads it.
  async pageFor(tabId) {
    return until(async () => {
      const { url } = await this.workerEval(`chrome.tabs.get(${tabId})`);
      return url && (await this.browser.pages()).find((p) => p.url() === url);
    });
  }
  // The tab once its page has loaded; tabs.create returns before the navigation commits.
  loaded(tabId) {
    return until(() => this.workerEval(`chrome.tabs.get(${tabId}).then(t=>t.status==='complete'&&t)`), 5000);
  }
  async focus(id = this.source.id) {
    const tab = await this.workerEval(`chrome.tabs.get(${id})`);
    await this.workerEval(
      `(async()=>{await chrome.windows.update(${tab.windowId},{focused:true});await chrome.tabs.update(${id},{active:true})})()`,
    );
    const page = await this.pageFor(id);
    await page.bringToFront();
    await until(() => this.focused(page));
    return page;
  }
  // Whether the page's document, or a guest view it embeds, has focus. Edge shows a PDF in a guest view, a `webview`
  // target under the page, and the outer document does not report focus held there.
  async focused(page) {
    if (await page.evaluate(() => document.hasFocus())) return true;
    const { targetInfos } = await this.root.send('Target.getTargets');
    const parent = targetInfos.find((t) => t.type === 'page' && t.url === page.url());
    for (const guest of targetInfos.filter((t) => t.type === 'webview' && t.parentId === parent?.targetId)) {
      const { sessionId } = await this.root.send('Target.attachToTarget', { targetId: guest.targetId, flatten: true });
      try {
        if (await this.eval(this.root.connection().session(sessionId), 'document.hasFocus()')) return true;
      } finally {
        await this.root.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
    }
    return false;
  }
  isPopup(t) {
    return t.url().startsWith(this.extensionBase + 'src/hosts/popup/index.html#');
  }
  popupTargets() {
    return this.browser.targets().filter((t) => this.isPopup(t));
  }
  // In Opera, waits out POPUP_SETTLE_MS since a popup last closed, before anything that can open one.
  async popupSettled() {
    const wait = (this.popupClosedAt ?? -Infinity) + POPUP_SETTLE_MS - Date.now();
    if (wait > 0) await pause(wait);
  }
  popupTarget() {
    return this.popupTargets()[0];
  }
  // A toolbar icon click in the tab's window, through the browser's own action path.
  async toolbar(tabId = this.source.id) {
    const page = await this.pageFor(tabId);
    const targets = await this.root.send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] });
    const info = targets.targetInfos.find((t) => t.url === page.url());
    if (!info) throw new Error('Fixture CDP tab target absent');
    await this.popupSettled();
    const wall = await this.workerEval('Date.now()');
    // Vivaldi has no Chromium toolbar: Extensions.triggerAction crashes its browser process, so the press makes the
    // call its own toolbar button makes.
    if (this.vivaldi) {
      const { windowId } = await this.workerEval(`chrome.tabs.get(${tabId})`);
      await this.eval(
        await until(() => this.vivaldiUi(windowId)),
        `new Promise((resolve,reject)=>vivaldi.extensionActionUtils.executeExtensionAction(${JSON.stringify(this.extensionId)},${windowId},()=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve(true)))`,
      );
    } else await this.root.send('Extensions.triggerAction', { id: this.extensionId, targetId: info.targetId });
    return { wall };
  }
  // The session of Vivaldi's UI page drawing the window, once that page is up; null before.
  async vivaldiUi(windowId) {
    this.vivaldiWindows ??= new Map();
    this.vivaldiTargets ??= new Set();
    if (!this.vivaldiWindows.has(windowId))
      for (const t of this.browser.targets()) {
        if (t.url() !== VIVALDI_UI || this.vivaldiTargets.has(t)) continue;
        const s = await t.createCDPSession();
        const id = await this.eval(s, 'chrome.windows.getCurrent().then((w)=>w.id)').catch(() => null);
        if (id === null) {
          await s.detach().catch(() => {});
          continue;
        }
        this.vivaldiTargets.add(t);
        this.vivaldiWindows.set(id, s);
      }
    return this.vivaldiWindows.get(windowId) ?? null;
  }
  // Vivaldi's UI page can miss a tab that opened before the page was up: it then adds an active start page tab in its
  // place and never shows the tab. In Vivaldi, waits until the tab's window page shows it.
  async vivaldiHosts({ id, windowId }) {
    if (!this.vivaldi) return;
    await until(async () => {
      const ui = await this.vivaldiUi(windowId);
      return ui && this.eval(ui, `!!document.getElementById('tab-${id}')`);
    }, 5000);
  }
  // Gives the tab the activeTab grant a real shortcut press gives, through one toolbar click; the popup closes again.
  async grant(tabId = this.source.id) {
    await this.focus(tabId);
    await this.toolbar(tabId);
    // Vivaldi's action.openPopup always rejects (Vivaldi bug VB-120122), so no popup follows its press.
    if (!this.vivaldi) await this.closePopup(await until(() => this.popupTarget(), 4000));
    await pause(100);
    await this.focus(tabId);
  }
  async closePopup(target) {
    const s = await target.createCDPSession();
    const { targetInfo } = await s.send('Target.getTargetInfo');
    await this.root.send('Target.closeTarget', { targetId: targetInfo.targetId });
  }
  async prepareOverlay() {
    await this.workerEval(
      `chrome.scripting.executeScript({target:{tabId:${this.source.id},frameIds:[0]},world:'ISOLATED',func:()=>chrome.runtime.id})`,
    );
    const s = await this.sourcePage.createCDPSession(),
      contexts = [];
    s.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
    await s.send('Runtime.enable');
    await s.send('DOM.enable');
    let context;
    for (const c of contexts)
      if (
        (await this.eval(s, 'typeof chrome!=="undefined" && chrome.runtime?.id', c.id).catch(() => null)) ===
        this.extensionId
      ) {
        context = c.id;
        break;
      }
    if (!context) throw new Error('Extension isolated world absent');
    this.overlay = { s, context, page: this.sourcePage, flavor: 'overlay' };
    await this.own(this.overlay, probeSource);
  }
  own(h, expression) {
    return this.eval(h.s, expression, h.context);
  }
  async panelCall(h, fn) {
    const tree = await h.s.send('DOM.getFlattenedDocument', { depth: -1, pierce: true });
    const node = tree.nodes.find((n) =>
      n.attributes?.some(
        (v, i, a) => v === 'class' && a[i + 1]?.split(' ').includes('panel') && a[i + 1]?.split(' ').includes(h.flavor),
      ),
    );
    if (!node) return null;
    const remote = await h.s.send('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
      ...(h.context ? { executionContextId: h.context } : {}),
    });
    const r = await h.s.send('Runtime.callFunctionOn', {
      objectId: remote.object.objectId,
      functionDeclaration: fn.toString(),
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  async inspect(h) {
    return (
      (await this.panelCall(h, inspectPanel)) ?? {
        connected: false,
        shown: false,
        rows: [],
        animations: [],
        selected: null,
        strip: null,
      }
    );
  }
  async probe(h) {
    return this.own(h, `(${readProbe.toString()})()`);
  }
  async resetProbe(h, freeze = []) {
    return this.own(
      h,
      `(()=>{const p=globalThis.__h1;p.animations=[];p.events=[];p.freeze=${JSON.stringify(freeze)};return true})()`,
    ).catch((e) => {
      if (/closed|detached/i.test(e.message)) return false;
      throw e;
    });
  }
  async resume(h) {
    await this.own(
      h,
      '(()=>{const p=__h1;p.freeze=[];for(const a of p.paused.splice(0))if(a.playState==="paused")a.play();return true})()',
    ).catch(() => {});
  }
  async key(h, key, mods = 0, up = true) {
    const codes = {
      ArrowDown: 40,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowLeft: 37,
      Enter: 13,
      Escape: 27,
      Backspace: 8,
      Tab: 9,
      f: 70,
    };
    const code = key.length === 1 ? 'Key' + key.toUpperCase() : key;
    try {
      await h.s.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code,
        modifiers: mods,
        windowsVirtualKeyCode: codes[key] ?? key.toUpperCase().charCodeAt(0),
      });
      if (up)
        await h.s.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key,
          code,
          modifiers: mods,
          windowsVirtualKeyCode: codes[key] ?? key.toUpperCase().charCodeAt(0),
        });
      return { sent: true };
    } catch (e) {
      if (/closed|detached/i.test(e.message)) return { sent: false, reason: 'Host already closed' };
      throw e;
    }
  }
  release(h) {
    return h.s
      .send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: HELD.key,
        code: HELD.code,
        modifiers: 0,
        windowsVirtualKeyCode: HELD.keyCode,
      })
      .catch((e) => {
        if (/closed|detached/i.test(e.message)) return { sent: false, reason: 'Host already closed' };
        throw e;
      });
  }
  async click(h, x, y) {
    await h.s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await h.s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async waitRemoved(h) {
    return until(async () => {
      try {
        const panel = await this.inspect(h);
        return !panel.connected && panel;
      } catch (e) {
        if (/closed|detached/i.test(e.message)) return { connected: false };
        throw e;
      }
    }, 1000);
  }
  async cancel(h) {
    if (!h) return;
    await this.resume(h);
    await this.key(h, 'Escape').catch(() => {});
    await this.waitRemoved(h);
  }
  // Every scenario starts here: no list on screen, no popup target, so no earlier gesture can survive into it.
  // Anything that outlived a cancel is closed and reported, then the worker gets past its 500 ms host deadline.
  async reset() {
    const h = this.last,
      forced = {};
    this.last = null;
    if (h?.s)
      await this.cancel(h).catch((e) => {
        forced.cancelError = scrub(e.message);
      });
    if ((await this.inspect(this.overlay)).connected) {
      forced.overlay = true;
      await this.cancel(this.overlay).catch(() => {});
    }
    const popups = this.popupTargets();
    if (popups.length) forced.popups = popups.length;
    for (const t of popups) await this.closePopup(t).catch(() => {});
    await until(async () => this.popupTargets().length === 0 && !(await this.inspect(this.overlay)).connected, 2000);
    if (Object.keys(forced).length) await pause(600);
    return forced;
  }
  // Waits for the worker's storage.onChanged for the write: the product's listener is registered first, so its settings
  // change is in ingress before any later press; writing the stored value fires nothing. Then the 45 ms settle the
  // look and motion scenarios' fixed pauses were tuned with.
  async settings(extra = {}) {
    const next = JSON.stringify({
      version: 1,
      quickTap: 'list',
      listSurface: 'overlay',
      theme: 'dark',
      textSize: 'default',
      reduceMotion: 'never',
      holdDelayMs: 0,
      tabOrder: 'recent',
      ...extra,
    });
    const changed = await this.workerEval(`(async()=>{
      const next=${next},canon=o=>JSON.stringify(Object.keys(o??{}).sort().map(k=>[k,o[k]]));
      const {settings}=await chrome.storage.local.get('settings');
      if(canon(settings)===canon(next))return 'same';
      return new Promise(resolve=>{
        const late=setTimeout(()=>resolve('timeout'),2000);
        const heard=(changes,area)=>{if(area==='local'&&changes.settings){chrome.storage.onChanged.removeListener(heard);clearTimeout(late);resolve('heard')}};
        chrome.storage.onChanged.addListener(heard);
        chrome.storage.local.set({settings:next});
      });
    })()`);
    if (changed === 'timeout') throw new Error('Settings change never reached the worker');
    await pause(45);
  }
  // Opens a list from `tab` (the fixture source by default) by shortcut or toolbar and returns its host handle once
  // the host listens; with `shown` (default) also once the list shows. `flavor` is the expected host, `listSurface`
  // the setting, so a fallback opens the popup from an overlay setting. `beforePress` runs after the window and page
  // setup, which would undo page state such as fullscreen, and before the press.
  async open(
    flavor,
    {
      tab = this.source,
      via = 'command',
      shown = true,
      listSurface = flavor,
      width = 1440,
      textSize = 'default',
      theme = 'dark',
      reduceMotion = 'never',
      osReduce = false,
      freeze = [],
      beforePress,
      ...settings
    } = {},
  ) {
    await this.settings({ listSurface, textSize, theme, reduceMotion, ...settings });
    const main = tab.id === this.source.id;
    if (main) await this.workerEval(`chrome.windows.update(${this.source.windowId},{width:${width},height:900})`);
    const page = await this.focus(tab.id);
    if (main) {
      await this.sourcePage.evaluate(() => {
        document.querySelector('#page-input').focus();
        window.__h1Page = [];
      });
      await this.overlay.s.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 850,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await this.media(this.overlay, osReduce, theme);
      await this.resetProbe(this.overlay, freeze);
    }
    this.popupDefaults = { freeze, osReduce, theme };
    await beforePress?.();
    const invocation = via === 'toolbar' ? await this.toolbar(tab.id) : await this.command(tab.id);
    let h = this.overlay;
    if (flavor === 'overlay' && !main) {
      h = { s: await page.createCDPSession(), page, flavor };
      await h.s.send('DOM.enable');
    }
    if (flavor === 'popup') {
      const target = await until(() => this.popupTarget(), 4000);
      const s = await target.createCDPSession();
      await s.send('DOM.enable');
      const page = await target.page();
      h = { s, page, flavor: 'popup' };
      // Owned before any startup check, so a failed setup is inspected and then closed by reset.
      this.last = h;
      await this.own(h, probeSource);
      // The target can surface before its renderer constructs the media query; wait for that sample, then judge it.
      const initialMedia = await until(
        () =>
          this.own(
            h,
            '__h1.media.find(row=>row.query==="(prefers-reduced-motion: reduce)" && Object.hasOwn(row,"initial"))',
          ),
        2000,
      ).catch(() => null);
      if (!initialMedia || initialMedia.initial !== osReduce || initialMedia.panelAlreadyMounted) {
        const closed = (await this.workerEval('__h1.closedPorts')).filter((x) => x.wall >= invocation.wall).length;
        throw new Error(
          `Popup startup media was not observed with the requested value before renderer construction; observed ${JSON.stringify(initialMedia ?? null)}; ports the worker closed since the press: ${closed}`,
        );
      }
      await this.media(h, osReduce, theme);
      await this.own(h, `__h1.freeze=${JSON.stringify(freeze)}`);
      this.e.metadata.popupMode = 'Real toolbar popup via chrome.action.openPopup, normal worker handshake';
    }
    this.last = h;
    // A fresh ready proves the command started a new host session rather than stepping a surviving gesture.
    const ready = async () =>
      (await this.workerMessages()).filter((m) => m.t === 'ready' && m.wall >= invocation.wall).at(-1)?.wall;
    // An overlay journey that fell back to the popup fails setup rather than sending keys to the page.
    await until(
      async () =>
        (flavor === 'popup' || this.popupTargets().length === 0) &&
        (!shown || (await this.inspect(h)).shown) &&
        (await ready()),
      4000,
    );
    h.visibleAt = Date.now();
    h.invokedAt = invocation.wall;
    h.readyAt = await ready();
    return h;
  }
  // Emulated OS reduced motion and colour scheme for a session, a page paused before its scripts included.
  emulate(s, reduce, theme = 'dark') {
    return s.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' },
        { name: 'prefers-color-scheme', value: theme === 'light' ? 'light' : 'dark' },
      ],
    });
  }
  // An emulated media change can stay unevaluated until a style update; a headless popup with its animations frozen
  // has gone seconds without one, its change listeners silent. Each poll reads computed style to supply that update,
  // then checks the probe's native query listener, so the caller observes the host after that event, without
  // waiting for a product outcome to pass.
  async media(h, reduce, theme = 'dark') {
    await this.emulate(h.s, reduce, theme);
    await until(
      () =>
        this.own(
          h,
          `(()=>{getComputedStyle(document.documentElement).color;const m=__h1.media.filter(x=>x.query==='(prefers-reduced-motion: reduce)').at(-1);return !m||(m.changed??m.initial)===${reduce}})()`,
        ),
      500,
    );
  }
  async shot(h, name) {
    const image = await h.s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(this.e.out, name), Buffer.from(image.data, 'base64'));
    return name;
  }
  async workerTimers() {
    return (await this.workerEval(`(${readProbe.toString()})()`)).timeouts.filter((t) => t.active && t.ms > 1000);
  }
  workerMessages() {
    return this.workerEval('__h1.messages');
  }
  // Whether the worker still evaluates, within the time any healthy evaluation takes.
  answers() {
    return within(5000, () => this.workerEval('true')).catch(() => false);
  }
  // Every chrome.windows.update call with focused true since the worker attached; headless reports every window
  // focused, so a journey observes the request.
  focusRequests() {
    return this.workerEval('__h1.focusRequests');
  }
  // Temporary browser facts have a normal finally cleanup, but abandoned work cannot send that cleanup itself.
  restoreBrowserApis() {
    return this.workerEval(
      `(()=>{for(const [api,key] of [[chrome.windows,'originalGetAll'],[chrome.commands,'originalCommands']])if(Object.hasOwn(__h1,key)){api.getAll=__h1[key];delete __h1[key]}return true})()`,
    );
  }
  async audibleFixture(enabled) {
    if (enabled)
      return this.workerEval(
        `(()=>{const native=chrome.windows.getAll;__h1.originalGetAll=native;chrome.windows.getAll=async(...args)=>{const windows=await native(...args);return windows.map(w=>({...w,tabs:w.tabs?.map(t=>({...t,audible:t.id===${this.audio.id}}))}))};return true})()`,
      );
    return this.restoreBrowserApis();
  }
  async stop() {
    if (this.browser) await this.browser.close();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    let alive = false;
    try {
      process.kill(this.pid, 0);
      alive = true;
    } catch {
      // ESRCH: the browser process is gone.
    }
    let remaining = [],
      processCheckError = null;
    // pgrep matches the profile path in each command line, so output scales with harness processes, never the whole
    // machine; pgrep exits 1 when none match, ps exits 1 when a listed pid has exited since.
    const run = (cmd, args) => {
      try {
        return execFileSync(cmd, args, { encoding: 'utf8' });
      } catch (err) {
        if (err.status === 1) return err.stdout;
        throw err;
      }
    };
    const profileProcesses = () => {
      if (process.platform === 'win32') return windowsProfileProcesses(this.profile);
      const pids = run('pgrep', ['-f', this.profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]).trim();
      return pids
        ? run('ps', ['-o', 'pid=,ppid=,command=', '-p', pids.split('\n').join(',')])
            .split('\n')
            .filter(Boolean)
        : [];
    };
    // Children can outlive the browser by a moment (Opera's crash reporter on Windows), so a remainder gets 3 s.
    try {
      const end = Date.now() + 3000;
      do {
        await pause(100);
        remaining = profileProcesses();
      } while (remaining.length && Date.now() < end);
    } catch (err) {
      processCheckError = scrub(err.message);
    }
    this.e.write('browser-shutdown.json', {
      pid: this.pid,
      alive,
      remaining,
      processCheckError,
      profileRetained: true,
      problems: this.problems,
      instrumentedPages: this.instrumented.size,
      pageBoots: this.pageBoots,
    });
    return !alive && remaining.length === 0 && !processCheckError;
  }
}
