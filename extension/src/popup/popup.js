/* Solarized Web — popup. Writes chrome.storage.sync; content scripts react live. */
(async () => {
  const SC = globalThis.SolarizedColor;
  const DEFAULTS = SC.DEFAULT_SETTINGS;
  const $ = (id) => document.getElementById(id);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = '', host = '';
  try {
    const u = new URL(tab.url);
    if (/^(https?|file):$/.test(u.protocol)) { url = u.href; host = u.hostname; }
  } catch { /* no URL */ }

  let s = await chrome.storage.sync.get(DEFAULTS);
  const save = (patch) => { s = { ...s, ...patch }; chrome.storage.sync.set(patch); render(); };
  const isHostEntry = (p) => !p.includes('://') && !p.includes('*');

  function render() {
    const hit = url ? SC.excludingPattern(url, s.excludePatterns) : null;
    $('host').textContent = host || (url ? 'Local file' : 'This page');
    $('site').checked = !!url && !hit && s.enabled;
    // A wildcard/URL pattern covers more than this site: edit it in the list.
    $('site').disabled = !url || !s.enabled || (!!hit && !isHostEntry(hit));
    const note = !url ? "This page can't be modified by extensions."
      : hit ? `Excluded by “${hit}”.` : '';
    $('siteNote').textContent = note;
    $('siteNote').hidden = !note;

    for (const k of ['enabled', 'invertDark', 'canvas', 'tintImages', 'font']) $(k).checked = !!s[k];
    for (const b of $('contrast').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.v === s.contrast));

    const list = $('exList');
    list.replaceChildren();
    if (!s.excludePatterns.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'None — every site is solarized.';
      list.append(li);
    }
    s.excludePatterns.forEach((p, i) => {
      const li = document.createElement('li');
      if (p === hit) li.className = 'hit';
      const span = document.createElement('span');
      span.textContent = p;
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = `Remove ${p}`;
      del.setAttribute('aria-label', `Remove ${p}`);
      del.addEventListener('click', () => save({ excludePatterns: s.excludePatterns.filter((_, j) => j !== i) }));
      li.append(span, del);
      list.append(li);
    });
  }

  function validate(p) {
    if (/\s/.test(p)) return 'No spaces, please.';
    if (p.includes('://') && !/^(https?|file|\*):\/\//.test(p)) return 'URLs must start with http://, https:// or file://.';
    if (s.excludePatterns.some((q) => q.toLowerCase() === p.toLowerCase())) return 'Already in the list.';
    return '';
  }

  $('exForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = $('exInput').value.trim();
    if (!p) return;
    const err = validate(p);
    $('exError').textContent = err;
    $('exError').hidden = !err;
    if (err) return;
    $('exInput').value = '';
    save({ excludePatterns: [...s.excludePatterns, p] });
  });

  $('site').addEventListener('change', (e) => {
    const hit = SC.excludingPattern(url, s.excludePatterns);
    if (e.target.checked && hit) save({ excludePatterns: s.excludePatterns.filter((p) => p !== hit) });
    else if (!e.target.checked && !hit) save({ excludePatterns: [...s.excludePatterns, host || url] });
  });
  for (const k of ['enabled', 'invertDark', 'canvas', 'tintImages', 'font']) {
    $(k).addEventListener('change', (e) => save({ [k]: e.target.checked }));
  }
  $('contrast').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (v) save({ contrast: v });
  });

  render();
})();
