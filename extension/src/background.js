/*
 * Solarized Web — background service worker.
 *  - Fetches cross-origin stylesheets for the content script (extension
 *    host permissions bypass CORS), with url() made absolute and @import
 *    inlined so the text works from a same-origin <style>.
 *  - Keyboard command to toggle the current site.
 *  - Injects into tabs that were already open when the extension installed.
 */
importScripts('colors.js');

const CSS_CACHE = new Map(); // url -> Promise<string|null>
const MAX_CACHE = 200;

function absolutizeUrls(css, base) {
  return css.replace(/url\(\s*(['"]?)([^'")]*?)\1\s*\)/g, (m, q, u) => {
    if (!u || /^(?:data:|https?:|blob:|#|about:|chrome-extension:)/i.test(u)) return m;
    try { return `url(${q}${new URL(u, base).href}${q})`; } catch { return m; }
  });
}

const IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/g;

async function inlineImports(css, base, depth) {
  const jobs = [];
  css.replace(IMPORT_RE, (m, _q1, u1, _q2, u2, cond) => {
    jobs.push({ m, url: new URL(u1 || u2, base).href, cond: cond.trim() });
    return m;
  });
  if (!jobs.length) return css;
  const texts = await Promise.all(jobs.map((j) => (depth < 4 ? fetchCss(j.url, depth + 1) : null)));
  jobs.forEach((j, i) => {
    let text = texts[i];
    if (text == null) {
      text = `@import url("${j.url}") ${j.cond};`; // keep as-is (absolute)
    } else {
      // Keep only the media part of the condition; layer()/supports() are dropped.
      const media = j.cond.replace(/layer(\([^)]*\))?|supports\([^)]*\)/g, '').trim();
      if (media) text = `@media ${media} {\n${text}\n}`;
    }
    css = css.replace(j.m, () => text);
  });
  return css;
}

function fetchCss(url, depth = 0) {
  if (CSS_CACHE.has(url)) return CSS_CACHE.get(url);
  const job = (async () => {
    try {
      // No cookies, and only real stylesheets: the text ends up readable by
      // the page, so anything else would let a page read cross-origin data.
      // 'default', not 'force-cache': the extension has its own HTTP cache
      // partition, so a stale entry would never be revalidated by the page.
      const res = await fetch(url, { cache: 'default', credentials: 'omit' });
      if (!res.ok) return null;
      if (!/^\s*text\/css\b/i.test(res.headers.get('content-type') || '')) return null;
      const css = absolutizeUrls(await res.text(), res.url || url);
      return await inlineImports(css, res.url || url, depth);
    } catch {
      return null;
    }
  })();
  if (CSS_CACHE.size >= MAX_CACHE) CSS_CACHE.delete(CSS_CACHE.keys().next().value);
  CSS_CACHE.set(url, job);
  job.then((t) => { if (t == null) CSS_CACHE.delete(url); });
  return job;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id || !sender.tab) return false;
  if (msg.type === 'sz-fetch-css' && typeof msg.url === 'string' && /^https?:/i.test(msg.url)) {
    fetchCss(msg.url).then(sendResponse);
    return true;
  }
  if (msg.type === 'sz-font-css') {
    const details = { target: { tabId: sender.tab.id, frameIds: [sender.frameId] }, files: ['src/font.css'] };
    (msg.on ? chrome.scripting.insertCSS(details) : chrome.scripting.removeCSS(details)).catch(() => {});
  }
  return false;
});

/*
 * Shortcut: exclude the current site by hostname, or re-include it if a
 * hostname entry is what excludes it. A wildcard/URL pattern is left alone
 * (edit those in the popup).
 */
async function toggleSite(tab) {
  if (!tab || !tab.url) return;
  let host;
  try { host = new URL(tab.url).hostname; } catch { return; }
  if (!host) return;
  const { excludePatterns } = await chrome.storage.sync.get({ excludePatterns: SolarizedColor.DEFAULT_SETTINGS.excludePatterns });
  const hit = SolarizedColor.excludingPattern(tab.url, excludePatterns);
  if (!hit) excludePatterns.push(host);
  else if (!hit.includes('://') && !hit.includes('*')) excludePatterns.splice(excludePatterns.indexOf(hit), 1);
  else return;
  await chrome.storage.sync.set({ excludePatterns });
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-site') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggleSite(tab);
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return; // not on browser updates
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    const target = { tabId: tab.id, allFrames: true };
    chrome.scripting.insertCSS({ target, files: ['src/base.css'] }).catch(() => {});
    chrome.scripting.executeScript({ target, files: ['src/colors.js', 'src/content.js'] }).catch(() => {});
  }
});
