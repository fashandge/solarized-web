/*
 * Solarized Web — content script (isolated world, document_start, all frames).
 *
 * Recolors the page by rewriting its CSS in place rather than computed
 * styles, so :hover, media queries and pseudo-elements keep working:
 *   - every rule of every stylesheet (incl. @media/@supports/@layer/nesting,
 *     @keyframes, adopted sheets and open/closed shadow roots);
 *   - cross-origin stylesheets, which the CSSOM hides, are fetched by the
 *     background worker and swapped for an equivalent same-origin <style>;
 *   - inline style="" and legacy color attributes (bgcolor, <font color>,
 *     SVG fill/stroke);
 *   - @media (prefers-color-scheme: dark) is neutralized so sites render
 *     their light theme; sites that are dark by design get inverted.
 * Every write is recorded so the page can be restored live when disabled.
 */
(() => {
  'use strict';
  if (window.__solarizedWebLoaded) return;
  window.__solarizedWebLoaded = true;

  const SC = globalThis.SolarizedColor;
  const docEl = document.documentElement;
  if (!SC || !docEl) return;

  // Reloading or updating the extension leaves the previous content script
  // running in its own isolated world. Two instances would recolor each
  // other's output forever and freeze the tab, so the newest instance tells
  // older ones to restore the page and retire (they listen for this below).
  const TAKEOVER = `solarized-web:takeover:${chrome.runtime.id}`;
  document.dispatchEvent(new CustomEvent(TAKEOVER));
  let retired = false;

  const isFrame = window !== window.top;
  if (isFrame) docEl.setAttribute('data-sz-frame', '');

  // Exclusions follow the top-level page, also inside iframes (which only
  // get to see the top page's origin).
  const topUrl = () => {
    if (!isFrame) return location.href;
    const anc = location.ancestorOrigins;
    return anc && anc.length ? anc[anc.length - 1] + '/' : location.href;
  };
  const frameHost = location.hostname || (() => { try { return new URL(topUrl()).hostname; } catch { return ''; } })();

  const COLOR_PROP = /(?:^|-)color$|^(?:fill|stroke|box-shadow|text-shadow|background-image)$/;
  const COLOR_ATTRS = ['bgcolor', 'color', 'text', 'link', 'vlink', 'alink', 'fill', 'stroke', 'stop-color'];
  const COLOR_ATTR_SET = new Set(COLOR_ATTRS);
  const OBSERVE = {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['style', 'href', 'media', 'rel', 'data-sz-off', 'data-sz-ready', ...COLOR_ATTRS],
  };

  let settings = { ...SC.DEFAULT_SETTINGS };
  let hostIsDark = false;
  const DARK_KEY = `dark:${frameHost}`;
  let mapper = null;            // non-null while active
  let observer = null;
  let rafId = 0;
  let pollId = 0;

  // Bookkeeping for restoring the page.
  let origs = new WeakMap();    // CSSStyleDeclaration -> Map(prop -> {orig, prio, val})
  let attrOrigs = new WeakMap(); // Element -> Map(attr -> {orig, val})
  let mediaOrigs = new WeakMap(); // MediaList -> {orig, val}
  // No strong lists of what we touched: stop() re-walks the live sheets and
  // DOM, so replaced stylesheets can be garbage-collected.
  let processedRules = new WeakSet();
  let sheetSigs = new WeakMap(); // sheet -> [length, firstRule, lastRule]
  let blockedSheets = new WeakSet(); // cross-origin sheets already proxied / failed
  const proxies = new Map();    // <link> -> proxy <style>
  const shadowRoots = new Set();
  const undefinedCustom = new Set();

  /* ---------------- declarations ---------------- */

  /*
   * Loop breaker: something keeps overwriting a value we recolored (a page
   * script, another recoloring extension). Re-map it at most 20 times per
   * second, so a tug-of-war can never lock up the tab.
   */
  function fighting(rec) {
    const now = performance.now();
    if (now - rec.t > 1000) { rec.t = now; rec.n = 0; }
    return ++rec.n > 20;
  }

  const flagsRec = { n: 0, t: 0 };

  function mapDecl(decl) {
    const n = decl.length;
    if (!n) return;
    const props = [];
    for (let i = 0; i < n; i++) {
      const p = decl[i];
      if (p.startsWith('--') || COLOR_PROP.test(p)) props.push(p);
    }
    if (!props.length) return;
    let mine = origs.get(decl);
    for (const p of props) {
      const v = decl.getPropertyValue(p);
      if (!v) continue;
      const rec = mine && mine.get(p);
      if (rec && rec.val === v) continue; // our own value
      if (rec && fighting(rec)) continue;
      let nv;
      if (p.startsWith('--')) nv = mapper.mapCustomProperty(v, p);
      else if (p === 'background-image') nv = v.includes('gradient') ? mapper.mapValue(v) : v;
      else nv = mapper.mapValue(v);
      if (nv === v) continue;
      const prio = decl.getPropertyPriority(p);
      decl.setProperty(p, nv, prio);
      const val = decl.getPropertyValue(p);
      if (!mine) origs.set(decl, (mine = new Map()));
      mine.set(p, { orig: v, prio, val, n: rec ? rec.n : 0, t: rec ? rec.t : 0 });
    }
  }

  function restoreDecl(decl) {
    const mine = origs.get(decl);
    if (!mine) return;
    for (const [p, { orig, prio, val }] of mine) {
      if (decl.getPropertyValue(p) === val) decl.setProperty(p, orig, prio);
    }
  }

  /* ---------------- attributes ---------------- */

  function mapAttr(el, name) {
    const v = el.getAttribute(name);
    if (!v) return;
    let mine = attrOrigs.get(el);
    const rec = mine && mine.get(name);
    if (rec && rec.val === v) return;
    if (rec && fighting(rec)) return;
    if (name === 'color' && el.localName !== 'font' && el.localName !== 'basefont') return;
    let nv = mapper.mapValue(v);
    if (nv === v && /^[0-9a-f]{6}$/i.test(v)) nv = mapper.mapColor('#' + v); // legacy bgcolor="ffffff"
    if (nv === v) return;
    el.setAttribute(name, nv);
    if (!mine) attrOrigs.set(el, (mine = new Map()));
    mine.set(name, { orig: v, val: nv, n: rec ? rec.n : 0, t: rec ? rec.t : 0 });
  }

  // Read the declaration, never the style attribute: after a CSSOM write
  // (el.style.transform = ...) getAttribute('style') forces Chrome to
  // re-serialize the whole declaration, which costs more than mapDecl.
  function mapInline(el) {
    if (el.style) mapDecl(el.style);
  }

  function processElement(el) {
    if (el.attributes.length) {
      for (const a of el.getAttributeNames()) {
        if (a === 'style') mapInline(el);
        else if (COLOR_ATTR_SET.has(a)) mapAttr(el, a);
      }
    }
    const name = el.localName;
    if (name.includes('-')) {
      const root = el.shadowRoot || (chrome.dom && chrome.dom.openOrClosedShadowRoot && chrome.dom.openOrClosedShadowRoot(el));
      if (root) addShadowRoot(root);
      else if (el.matches(':not(:defined)')) undefinedCustom.add(el);
    } else if (el.shadowRoot) {
      addShadowRoot(el.shadowRoot);
    }
  }

  function processTree(root) {
    if (root.nodeType === 1) processElement(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) processElement(el);
  }

  function addShadowRoot(root) {
    if (shadowRoots.has(root)) return;
    shadowRoots.add(root);
    if (observer) observer.observe(root, OBSERVE);
    processSheetList(root.styleSheets);
    if (root.adoptedStyleSheets) processSheetList(root.adoptedStyleSheets);
    processTree(root);
  }

  /* ---------------- stylesheets ---------------- */

  const RE_DARK = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi;
  const RE_LIGHT = /\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi;

  function fixMedia(media) {
    if (!media) return;
    const t = media.mediaText;
    if (!t || !t.includes('prefers-color-scheme')) return;
    const nt = t.replace(RE_DARK, '(max-width: 0px)').replace(RE_LIGHT, '(min-width: 0px)');
    if (nt === t) return;
    media.mediaText = nt;
    mediaOrigs.set(media, { orig: t, val: media.mediaText });
  }

  function walkRules(rules, from = 0) {
    for (let i = from; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.media) fixMedia(rule.media);
      if (rule.styleSheet) { processSheet(rule.styleSheet); continue; } // @import
      if (rule.style && !processedRules.has(rule)) {
        processedRules.add(rule);
        mapDecl(rule.style);
      }
      if (rule.cssRules) walkRules(rule.cssRules);
    }
  }

  function processSheet(sheet) {
    if (blockedSheets.has(sheet)) return;
    const owner = sheet.ownerNode;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      blockedSheets.add(sheet);
      if (owner && owner.localName === 'link') proxyLink(owner, sheet);
      return;
    }
    if (!rules) return;
    const n = rules.length;
    const sig = sheetSigs.get(sheet);
    if (sig && sig[0] === n && sig[1] === rules[0] && sig[2] === rules[n - 1]) return;
    sheetSigs.set(sheet, [n, rules[0], rules[n - 1]]);
    // Rules appended at the end (the common CSS-in-JS case): first rule and
    // old last rule unchanged, so only the new tail needs walking.
    if (sig && sig[0] > 0 && n > sig[0] && rules[0] === sig[1] && rules[sig[0] - 1] === sig[2]) {
      walkRules(rules, sig[0]);
      return;
    }
    if (!sig) fixMedia(sheet.media);
    walkRules(rules);
  }

  function processSheetList(list) {
    for (let i = 0; i < list.length; i++) {
      const sheet = list[i];
      if (sheet.disabled && proxies.has(sheet.ownerNode)) continue;
      processSheet(sheet);
    }
  }

  function processDocumentSheets() {
    processSheetList(document.styleSheets);
    if (document.adoptedStyleSheets) processSheetList(document.adoptedStyleSheets);
  }

  function processAllSheets() {
    processDocumentSheets();
    for (const root of shadowRoots) {
      if (!root.host.isConnected) continue;
      processSheetList(root.styleSheets);
      if (root.adoptedStyleSheets) processSheetList(root.adoptedStyleSheets);
    }
  }

  /* Cross-origin sheet: fetch its text via the background worker and insert
   * an equivalent <style> right after the <link>, then disable the original. */
  async function proxyLink(link, sheet) {
    const href = link.href;
    if (!href || proxies.has(link)) return;
    let text = null;
    try {
      text = await chrome.runtime.sendMessage({ type: 'sz-fetch-css', url: href });
    } catch { /* extension reloaded or fetch failed */ }
    if (!mapper || typeof text !== 'string' || !link.isConnected || link.href !== href || link.sheet !== sheet) return;
    const style = document.createElement('style');
    style.setAttribute('data-sz-proxy', href);
    const media = sheet.media && sheet.media.mediaText;
    if (media) style.media = media;
    style.textContent = text;
    link.after(style);
    if (!style.sheet) { style.remove(); return; } // blocked by the page's CSP
    sheet.disabled = true;
    proxies.set(link, style);
    processSheet(style.sheet);
  }

  function dropProxy(link) {
    const style = proxies.get(link);
    proxies.delete(link);
    if (style) style.remove();
    if (link.sheet) link.sheet.disabled = false;
  }

  /* ---------------- observation ---------------- */

  function onMutations(muts) {
    if (!mapper) return;
    let sheetsDirty = false;
    for (const m of muts) {
      if (m.type === 'childList') {
        const tname = m.target.localName;
        if (tname === 'style') sheetsDirty = true;
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          heatUp(); // CSS-in-JS inserts its rules when components mount
          const name = node.localName;
          if (name === 'style' || name === 'link') { sheetsDirty = true; continue; }
          processTree(node);
          if (node.firstElementChild && node.querySelector('style, link')) sheetsDirty = true;
        }
        if (proxies.size) {
          for (const node of m.removedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.localName === 'link') { if (proxies.has(node)) dropProxy(node); }
            else if (node.firstElementChild) for (const l of node.querySelectorAll('link')) if (proxies.has(l)) dropProxy(l);
          }
        }
      } else {
        const el = m.target, a = m.attributeName;
        if (a === 'style') {
          mapInline(el);
        } else if (a === 'data-sz-off' || a === 'data-sz-ready') {
          // Re-assert flags the page clobbered, rate-limited: two instances
          // that disagree (e.g. one not yet ready) would otherwise loop.
          if (el === docEl && !fighting(flagsRec)) setFlags();
        } else if (el.localName === 'link' || el.localName === 'style') {
          if (a === 'href' && proxies.has(el)) dropProxy(el);
          if (a !== 'color') sheetsDirty = true;
        } else if (COLOR_ATTR_SET.has(a)) {
          mapAttr(el, a);
        }
      }
    }
    if (sheetsDirty) processAllSheets();
  }

  // CSS-in-JS inserts rules through the CSSOM, which fires no mutation; a
  // per-frame signature check catches them before they are painted. Such
  // inserts come with element insertions, so the check only runs for a
  // second after elements were added, and only over document-level sheets;
  // shadow roots and anything else are left to poll() every 1.5 s.
  let hotUntil = 0;
  function heatUp(ms = 1000) {
    hotUntil = Math.max(hotUntil, performance.now() + ms);
    if (!rafId) rafId = requestAnimationFrame(frameLoop);
  }
  function frameLoop() {
    processDocumentSheets();
    rafId = mapper && performance.now() < hotUntil ? requestAnimationFrame(frameLoop) : 0;
  }

  function poll() {
    if (!chrome.runtime || !chrome.runtime.id) { retire(); return; } // extension reloaded/removed
    processAllSheets();
    for (const el of undefinedCustom) {
      if (!el.isConnected) { undefinedCustom.delete(el); continue; }
      const root = el.shadowRoot || (chrome.dom && chrome.dom.openOrClosedShadowRoot && chrome.dom.openOrClosedShadowRoot(el));
      if (root) { undefinedCustom.delete(el); addShadowRoot(root); }
      else if (el.matches(':defined')) undefinedCustom.delete(el);
    }
    for (const root of shadowRoots) if (!root.host.isConnected) shadowRoots.delete(root);
  }

  const onLinkLoad = (e) => {
    if (mapper && e.target && e.target.localName === 'link') processAllSheets();
  };

  /* ---------------- dark-page detection ---------------- */

  function bgLumAt(el) {
    for (; el; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor;
      const l = SC.luminance(c);
      if (l && l.alpha > 0.5) return l.lum;
    }
    return null;
  }

  /* Relative luminance of what the page shows as its background *now*. */
  function pageBgLum() {
    const body = document.body;
    const direct = [body, docEl].map((el) => el && SC.luminance(getComputedStyle(el).backgroundColor))
      .find((l) => l && l.alpha > 0.5);
    if (direct) return direct.lum;
    const W = innerWidth, H = innerHeight;
    const lums = [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.25, 0.75], [0.75, 0.75]]
      .map(([x, y]) => bgLumAt(document.elementFromPoint(W * x, H * y)))
      .filter((l) => l !== null)
      .sort((p, q) => p - q);
    return lums.length ? lums[lums.length >> 1] : 0.9;
  }

  // The mapping is monotone, so the mapped background tells us whether the
  // original was dark: in normal mode it stays dark, in invert mode it is light.
  let darkFlipped = false;

  function checkDarkness() {
    if (retired || !mapper || !ready || !settings.invertDark || !document.body) return;
    const lum = pageBgLum();
    const originalDark = mapper.invert ? lum > 0.35 : lum < 0.2;
    // Decide once: if the measurement is ambiguous it could flip forever.
    if (originalDark !== mapper.invert && !darkFlipped) {
      darkFlipped = true;
      hostIsDark = originalDark;
      (originalDark ? chrome.storage.local.set({ [DARK_KEY]: true }) : chrome.storage.local.remove(DARK_KEY)).catch(() => {});
      restart();
    }
  }

  /* ---------------- lifecycle ---------------- */

  const shouldRun = () => settings.enabled && !SC.excludingPattern(topUrl(), settings.excludePatterns);

  function setFlags() {
    const want = {
      'data-sz-off': !mapper,
      'data-sz-ready': !!mapper && ready,
      'data-sz-tint': !!mapper && settings.tintImages,
      'data-sz-font': !!mapper && settings.font,
      'data-sz-canvas': !!mapper && settings.canvas,
      'data-sz-invert': !!mapper && mapper.invert,
    };
    for (const [k, on] of Object.entries(want)) {
      if (on !== docEl.hasAttribute(k)) on ? docEl.setAttribute(k, '') : docEl.removeAttribute(k);
    }
    setFontCss(want['data-sz-font']);
  }

  // The font rule must match every element, and Chrome evaluates such a rule
  // on every style recalc even when its html[...] gate is false, so it is
  // only inserted (by the service worker) while the option is on.
  let fontCssOn = false;
  function setFontCss(on) {
    if (on === fontCssOn) return;
    fontCssOn = on;
    try { chrome.runtime.sendMessage({ type: 'sz-font-css', on }).catch(() => {}); } catch { /* orphaned */ }
  }

  let ready = false;
  let readyTimer = 0;

  function start() {
    mapper = SC.createMapper({
      contrast: settings.contrast,
      invert: settings.invertDark && hostIsDark,
    });
    setFlags();
    processAllSheets();
    processTree(document);
    observer = new MutationObserver(onMutations);
    observer.observe(document, OBSERVE);
    for (const root of shadowRoots) observer.observe(root, OBSERVE);
    document.addEventListener('load', onLinkLoad, true);
    heatUp(3000);
    pollId = setInterval(poll, 1500);
    whenDomReady(() => {
      if (!mapper) return;
      processAllSheets();
      clearTimeout(readyTimer);
      // Give cross-origin proxies a moment before dropping the first-paint guard.
      readyTimer = setTimeout(() => { ready = true; setFlags(); checkDarkness(); }, 150);
    });
  }

  function restoreMedia(media) {
    const rec = media && mediaOrigs.get(media);
    if (rec && media.mediaText === rec.val) media.mediaText = rec.orig;
  }

  function restoreRules(rules) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.media) restoreMedia(rule.media);
      if (rule.styleSheet) { restoreSheet(rule.styleSheet); continue; }
      if (rule.style) restoreDecl(rule.style);
      if (rule.cssRules) restoreRules(rule.cssRules);
    }
  }

  function restoreSheet(sheet) {
    let rules;
    try { rules = sheet.cssRules; } catch { return; } // cross-origin: never touched
    restoreMedia(sheet.media);
    if (rules) restoreRules(rules);
  }

  function stop(keepProxies = false) {
    if (!mapper) return;
    mapper = null;
    observer.disconnect();
    observer = null;
    cancelAnimationFrame(rafId);
    rafId = 0;
    clearInterval(pollId);
    clearTimeout(readyTimer);
    document.removeEventListener('load', onLinkLoad, true);

    const roots = [document, ...shadowRoots];
    for (const root of roots) {
      for (const sheet of root.styleSheets) restoreSheet(sheet);
      for (const sheet of root.adoptedStyleSheets || []) restoreSheet(sheet);
    }
    // A restart keeps the proxies (restored above, re-mapped by start())
    // rather than re-fetching and re-parsing them.
    if (!keepProxies) for (const link of [...proxies.keys()]) dropProxy(link);
    for (const root of roots) {
      for (const el of root.querySelectorAll('[style]')) if (el.style) restoreDecl(el.style);
      for (const el of root.querySelectorAll(COLOR_ATTRS.map((a) => `[${a}]`).join(','))) {
        const mine = attrOrigs.get(el);
        if (!mine) continue;
        for (const [a, { orig, val }] of mine) if (el.getAttribute(a) === val) el.setAttribute(a, orig);
      }
    }
    origs = new WeakMap();
    attrOrigs = new WeakMap();
    mediaOrigs = new WeakMap();
    processedRules = new WeakSet();
    sheetSigs = new WeakMap();
    blockedSheets = new WeakSet();
    setFlags();
  }

  function restart() {
    const wasReady = ready;
    stop(true);
    if (shouldRun()) {
      start();
      if (wasReady) { ready = true; setFlags(); }
    } else {
      for (const link of [...proxies.keys()]) dropProxy(link);
    }
  }

  function whenDomReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function retire() {
    if (retired) return;
    retired = true;
    document.removeEventListener(TAKEOVER, retire);
    stop();
  }
  document.addEventListener(TAKEOVER, retire);

  function applySettings(next) {
    if (retired) return;
    const prev = settings;
    settings = { ...SC.DEFAULT_SETTINGS, ...next };
    const run = shouldRun();
    if (!run) { stop(); setFlags(); return; } // setFlags: stop() is a no-op if never started
    if (!mapper) { start(); return; }
    if (prev.contrast !== settings.contrast || prev.invertDark !== settings.invertDark) restart();
    else setFlags();
  }

  Promise.all([
    chrome.storage.sync.get(SC.DEFAULT_SETTINGS),
    chrome.storage.local.get(DARK_KEY),
  ]).then(([s, l]) => {
    hostIsDark = !!l[DARK_KEY];
    applySettings(s);
    // SPAs often paint their real background after load.
    window.addEventListener('load', () => setTimeout(checkDarkness, 300), { once: true });
    setTimeout(checkDarkness, 2500);
  }).catch(() => applySettings({}));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    chrome.storage.sync.get(SC.DEFAULT_SETTINGS).then(applySettings);
  });
})();
