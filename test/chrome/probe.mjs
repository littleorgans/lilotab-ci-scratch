// Installed through CDP in this run's disposable browser worlds only.
export function installProbe() {
  if (globalThis.__h1) return;
  const p = (globalThis.__h1 = {
    installedAt: performance.now(),
    events: [],
    media: [],
    animations: [],
    intervals: [],
    timeouts: [],
    listeners: [],
    paused: [],
    freeze: [],
    seq: 0,
  });
  const now = () => performance.now();
  const log = (kind, data) => p.events.push({ at: now(), kind, ...data });
  const timers = (set, clear, list, repeating) => {
    if (typeof globalThis[set] !== 'function' || typeof globalThis[clear] !== 'function') return;
    const nativeSet = globalThis[set].bind(globalThis),
      nativeClear = globalThis[clear].bind(globalThis);
    globalThis[set] = function (fn, ms, ...args) {
      const row = { token: ++p.seq, ms, at: now(), due: now() + Number(ms), active: true, fires: 0 };
      const call = () => {
        row.fires++;
        if (!repeating) row.active = false;
        return typeof fn === 'function' ? fn(...args) : undefined;
      };
      const id = nativeSet(call, ms);
      row.id = id;
      row.call = call;
      list.push(row);
      return id;
    };
    globalThis[clear] = function (id) {
      const row = list.find((x) => x.id === id);
      if (row) row.active = false;
      return nativeClear(id);
    };
  };
  timers('setInterval', 'clearInterval', p.intervals, true);
  timers('setTimeout', 'clearTimeout', p.timeouts, false);
  if (typeof Element === 'undefined') return;
  // What the first paint shows: rendering runs animation frame callbacks just before it paints.
  requestAnimationFrame(() => {
    const body = document.querySelector('body')?.getBoundingClientRect();
    p.firstFrame = {
      at: now(),
      width: body?.width ?? 0,
      height: body?.height ?? 0,
      viewport: { width: innerWidth, height: innerHeight },
      background: getComputedStyle(document.documentElement).backgroundColor,
      rows: document.querySelectorAll('[role="option"]').length,
    };
  });
  const add = EventTarget.prototype.addEventListener,
    remove = EventTarget.prototype.removeEventListener;
  const matchMedia = globalThis.matchMedia.bind(globalThis);
  globalThis.matchMedia = function (query) {
    const result = matchMedia(query);
    p.media.push({
      query,
      at: now(),
      initial: result.matches,
      ready: document.readyState,
      panelAlreadyMounted: !!document.querySelector('.panel'),
    });
    add.call(result, 'change', () => p.media.push({ query, at: now(), changed: result.matches }));
    return result;
  };
  EventTarget.prototype.addEventListener = function (type, fn, options) {
    if (typeof fn === 'function')
      p.listeners.push({
        target: this,
        type,
        fn,
        capture: typeof options === 'boolean' ? options : !!options?.capture,
        active: true,
      });
    add.call(this, type, fn, options);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    for (const row of p.listeners)
      if (row.target === this && row.type === type && row.fn === fn && row.capture === capture) row.active = false;
    remove.call(this, type, fn, options);
  };
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const animation = animate.call(this, frames, options);
    const timing = animation.effect.getTiming();
    const row = {
      at: now(),
      source: 'WAAPI',
      target: this.getAttribute('class') ?? '',
      timing,
      frames: animation.effect.getKeyframes(),
      state: 'running',
    };
    p.animations.push(row);
    if (p.freeze.includes(timing.duration)) {
      animation.pause();
      p.paused.push(animation);
      row.pausedForObservation = true;
    }
    animation.finished.then(
      () => {
        row.state = 'finished';
        row.ended = now();
      },
      () => {
        row.state = 'cancelled';
        row.ended = now();
      },
    );
    return animation;
  };
  const captureCSS = (e) => {
    for (const a of e.target.getAnimations())
      p.animations.push({
        at: now(),
        source: 'CSS',
        target: e.target.className,
        timing: a.effect.getTiming(),
        frames: a.effect.getKeyframes(),
      });
  };
  add.call(document, 'animationstart', captureCSS, true);
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (options) {
    const root = attachShadow.call(this, options);
    add.call(root, 'animationstart', captureCSS, true);
    return root;
  };
  // A microtask can run between DOM listeners. Keep one mutable observation per
  // event and update it after the host calls the native prevention methods.
  // This also sees swallowed events when a popup's sensors precede this probe.
  const inputs = new WeakMap();
  const inputTypes = new Set(['keydown', 'keyup', 'pointerdown', 'click']);
  const observeInput = (e) => {
    if (!inputTypes.has(e.type)) return null;
    let row = inputs.get(e);
    if (!row) {
      row = { at: now(), kind: 'input', type: e.type, key: e.key ?? null, code: e.code ?? null, trusted: e.isTrusted };
      inputs.set(e, row);
      p.events.push(row);
    }
    row.prevented = e.defaultPrevented;
    return row;
  };
  for (const method of ['preventDefault', 'stopImmediatePropagation']) {
    const native = Event.prototype[method];
    Event.prototype[method] = function (...args) {
      const result = native.apply(this, args),
        row = observeInput(this);
      if (row && method === 'stopImmediatePropagation') row.stopped = true;
      return result;
    };
  }
  for (const type of inputTypes) add.call(window, type, observeInput, true);
  for (const type of ['keydown', 'keyup'])
    add.call(document, type, (e) => log('downstream', { type, key: e.key, trusted: e.isTrusted }), false);
  add.call(window, 'focus', (e) => log('focus', { target: e.target.nodeName }), true);
  add.call(window, 'blur', (e) => log('blur', { target: e.target.nodeName }), true);
}

// Runs with `this` bound to the actual panel resolved through CDP DOM pierce.
export function inspectPanel() {
  const rect = (e) => {
    const r = e?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  };
  const style = getComputedStyle(this),
    strip = this.querySelector('.strip'),
    head = this.querySelector('.head'),
    input = this.querySelector('.field'),
    root = this.getRootNode();
  const hidden = (e) => !!e.closest('[aria-hidden="true"]');
  const rowInfo = (e) => ({
    id: e.id,
    title: e.querySelector('.title')?.textContent,
    label: e.getAttribute('aria-label'),
    selected: e.getAttribute('aria-selected') === 'true',
    rect: rect(e),
    sound: [...e.querySelectorAll('svg')].some((s) => !!s.querySelector('path[d="M2 6h2.5L8 3v10L4.5 10H2z"]')),
    svgs: [...e.querySelectorAll('svg')].map((s) => ({
      class: s.getAttribute('class'),
      hidden: s.getAttribute('aria-hidden'),
      width: rect(s).width,
    })),
  });
  const lists = [...this.querySelectorAll('.list')].map((e) => ({
    rect: rect(e),
    hidden: hidden(e),
    inert: !!e.closest('[inert]'),
    ids: [...e.querySelectorAll('[id], [aria-activedescendant], [aria-controls]')].map(
      (n) => n.id || n.getAttribute('aria-controls'),
    ),
    rows: e.querySelectorAll('[role="option"]').length,
  }));
  const liveList = [...this.querySelectorAll('.list')].find((e) => !hidden(e));
  const selected = liveList?.querySelector('[role="option"][aria-selected="true"]');
  return {
    connected: this.isConnected,
    class: this.className,
    rect: rect(this),
    viewport: { width: innerWidth, height: innerHeight },
    shown: style.visibility !== 'hidden' && this.isConnected,
    inert: this.inert,
    opacity: style.opacity,
    background: style.backgroundColor,
    backdrop: style.backdropFilter,
    shadow: style.boxShadow,
    color: style.color,
    head: rect(head),
    headLayoutHeight: head?.offsetHeight ?? null,
    search: liveList?.classList.contains('search') ?? false,
    field: rect(input),
    fieldFocused: !!input && root.activeElement === input,
    hostEditable: root.host?.contentEditable ?? null, // the overlay host; null in the popup
    fieldText: input?.value ?? null,
    fieldSelection: input ? [input.selectionStart, input.selectionEnd] : null,
    notice: this.querySelector('.notice')?.textContent ?? '',
    listFocused: root.activeElement === liveList,
    hasFocus: document.hasFocus(),
    active: root.activeElement?.className ?? document.activeElement?.id,
    strip: strip
      ? {
          rect: rect(strip),
          scrollLeft: strip.scrollLeft,
          clientWidth: strip.clientWidth,
          scrollWidth: strip.scrollWidth,
          gap: getComputedStyle(strip).gap,
          cells: [...strip.children].map((e) => ({
            rect: rect(e),
            selected: e.getAttribute('aria-selected') === 'true',
          })),
        }
      : null,
    lists,
    selected: selected ? rowInfo(selected) : null,
    rows: [...this.querySelectorAll('.list [role="option"]')].filter((e) => !hidden(e)).map(rowInfo),
    animations: this.getAnimations({ subtree: true }).map((a) => ({
      target: a.effect.target.className,
      state: a.playState,
      timing: a.effect.getTiming(),
      frames: a.effect.getKeyframes(),
    })),
  };
}

export function readProbe() {
  const p = globalThis.__h1;
  if (!p) return { installed: false };
  const cleanTimer = ({ call: _call, ...row }) => row;
  return {
    installed: true,
    installedAt: p.installedAt,
    firstFrame: p.firstFrame ?? null,
    events: p.events,
    media: p.media,
    animations: p.animations,
    intervals: p.intervals.map(cleanTimer),
    timeouts: p.timeouts.map(cleanTimer),
    activeSensors: p.listeners
      .filter(
        (x) =>
          x.active &&
          [
            'keydown',
            'keyup',
            'pointermove',
            'pointerdown',
            'input',
            'beforeinput',
            'compositionstart',
            'compositionend',
            'blur',
            'visibilitychange',
            'pagehide',
            'click',
            'wheel',
            'mousedown',
          ].includes(x.type),
      )
      .map((x) => ({
        type: x.type,
        target:
          x.target === window
            ? 'window'
            : x.target === document
              ? 'document'
              : (x.target.className ?? x.target.nodeName),
      })),
  };
}
