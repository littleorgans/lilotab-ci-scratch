import fs from 'node:fs';
import http from 'node:http';
import { pause, until } from './support.mjs';

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
  c.fixtureWindows = new Set(c.windows.map((w) => w.id));
  c.fixtureTabs = new Set([...c.windows.map((w) => w.tabs[0].id), c.other.id, c.audio.id]);
  await close(await c.strayTabs());
  await pause(350);
  c.stage = 'window focus';
  await c.recentOrder();
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
