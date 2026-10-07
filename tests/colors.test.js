const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../extension/src/colors.js');

const lum = (c) => S.luminance(c).lum;

test('white backgrounds become Solarized base3', () => {
  const m = S.createMapper({});
  for (const c of ['#fff', '#ffffff', 'white', 'rgb(255, 255, 255)', 'hsl(0 0% 100%)', 'oklch(1 0 0)', 'Canvas']) {
    assert.equal(m.mapColor(c), '#fdf6e3', c);
  }
});

test('black text maps to the contrast setting', () => {
  assert.equal(S.createMapper({ contrast: 'soft' }).mapColor('#000'), '#586e75');
  assert.equal(S.createMapper({ contrast: 'normal' }).mapColor('#000'), '#073642');
  assert.equal(S.createMapper({ contrast: 'high' }).mapColor('#000'), '#002b36');
});

test('lightness order of grays is preserved', () => {
  const m = S.createMapper({});
  const grays = ['#fff', '#f5f5f5', '#ddd', '#aaa', '#777', '#444', '#111'];
  const out = grays.map((g) => lum(m.mapColor(g)));
  for (let i = 1; i < out.length; i++) assert.ok(out[i] < out[i - 1], `${grays[i]} darker than ${grays[i - 1]}`);
});

test('contrast is preserved up to the knee, compressed above it', () => {
  const m = S.createMapper({ contrast: 'normal' });
  const cr = (fg, bg) => { const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  for (const g of ['#59636e', '#767676', '#999', '#0969da']) {
    assert.ok(Math.abs(cr(m.mapColor(g), '#fdf6e3') - cr(g, '#fff')) < 0.25, g); // secondary text keeps its contrast
  }
  assert.ok(cr(m.mapColor('#1f2328'), '#fdf6e3') < cr('#1f2328', '#fff')); // near-black is softened
});

test('every contrast setting keeps a fine gray ramp strictly ordered and distinct', () => {
  const ramp = [];
  for (let v = 0; v <= 255; v += 0x11) ramp.push('#' + v.toString(16).padStart(2, '0').repeat(3));
  for (const contrast of ['soft', 'normal', 'high']) {
    const m = S.createMapper({ contrast });
    const out = ramp.map((g) => m.mapColor(g));
    assert.equal(new Set(out).size, out.length, `${contrast}: distinct outputs`);
    for (let i = 1; i < out.length; i++) assert.ok(lum(out[i]) > lum(out[i - 1]), `${contrast}: ${ramp[i]} lighter than ${ramp[i - 1]}`);
  }
});

test('dark UI pairs stay distinguishable (Bootstrap navbar-dark vs dropdown-menu-dark)', () => {
  const m = S.createMapper({ contrast: 'normal' });
  const cr = (p, q) => { const a = lum(p), b = lum(q); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  assert.ok(cr(m.mapColor('#212529'), m.mapColor('#343a40')) > 1.1);
  assert.ok(cr(m.mapColor('#000'), m.mapColor('#333')) > 1.3);
});

test('invert mode preserves contrast of dark-theme text against the page', () => {
  const m = S.createMapper({ invert: true });
  const cr = (p, q) => { const a = lum(p), b = lum(q); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  // GitHub dark muted text on its page background, before and after.
  const before = cr('#9198a1', '#0d1117');
  const after = cr(m.mapColor('#9198a1'), m.mapColor('#0d1117'));
  assert.ok(Math.abs(after - before) < 0.6, `${before} -> ${after}`);
});

test('invert mode turns dark page backgrounds light and light text dark', () => {
  const m = S.createMapper({ invert: true });
  assert.ok(lum(m.mapColor('#121212')) > 0.85);
  assert.ok(lum(m.mapColor('#e6e6e6')) < 0.1);
});

test('hues keep their category', () => {
  const m = S.createMapper({});
  const hue = (c) => { const [, a, b] = S.parseColor(c).lab; return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360; };
  const dist = (x, y) => Math.min(Math.abs(x - y), 360 - Math.abs(x - y));
  for (const [src, acc] of [['#0000ff', 'blue'], ['#ff0000', 'red'], ['#00ff00', 'green'], ['#ffff00', 'yellow']]) {
    assert.ok(dist(hue(m.mapColor(src)), hue(S.PALETTE[acc])) < 12, `${src} -> ${acc}`);
  }
});

test('alpha is preserved, including var() alpha', () => {
  const m = S.createMapper({});
  assert.equal(m.mapColor('rgba(0, 0, 0, 0.1)'), 'rgba(7, 54, 66, 0.1)');
  assert.equal(m.mapValue('rgba(255, 255, 255, var(--a))'), 'rgba(253, 246, 227, var(--a))');
  assert.equal(m.mapValue('rgb(0 0 0 / 20%)'), 'rgba(7, 54, 66, 0.2)');
});

test('values: gradients and shadows mapped, url() and var() left alone', () => {
  const m = S.createMapper({});
  assert.equal(m.mapValue('linear-gradient(#fff, black)'), 'linear-gradient(#fdf6e3, #073642)');
  assert.equal(m.mapValue('url(#fff) no-repeat'), 'url(#fff) no-repeat');
  assert.equal(m.mapValue('var(--white)'), 'var(--white)');
  assert.equal(m.mapValue('rgba(var(--x), .5)'), 'rgba(var(--x), .5)');
  assert.equal(m.mapValue('transparent'), 'transparent');
  assert.equal(m.mapValue('currentColor'), 'currentColor');
});

test('custom properties with bare channels keep their format', () => {
  const m = S.createMapper({});
  assert.equal(m.mapCustomProperty('255, 255, 255', '--bs-body-bg-rgb'), '253, 246, 227');
  assert.equal(m.mapCustomProperty('255 255 255', '--bg'), '253 246 227');
  assert.match(m.mapCustomProperty('0 0% 100%', '--background'), /^[\d.]+ [\d.]+% [\d.]+%$/);
  assert.equal(m.mapCustomProperty('100 200 300', '--bg'), '100 200 300'); // not a color
  assert.equal(m.mapCustomProperty('12 24 36', '--grid-cols'), '12 24 36');
});

test('default exclusions: any 127.0.0.1 port', () => {
  const P = S.DEFAULT_SETTINGS.excludePatterns;
  const ex = (u) => S.excludingPattern(u, P);
  assert.equal(ex('http://127.0.0.1:8000/'), 'http://127.0.0.1:*');
  assert.equal(ex('http://127.0.0.1:5173/app#x'), 'http://127.0.0.1:*');
  for (const u of ['http://localhost:8000/', 'https://x.com/']) assert.equal(ex(u), null, u);
});

test('a URL-prefix exclusion covers a whole site', () => {
  const P = ['https://notes.example.dev/'];
  assert.equal(S.excludingPattern('https://notes.example.dev/', P), P[0]);
  assert.equal(S.excludingPattern('https://notes.example.dev/a?q=1', P), P[0]);
  assert.equal(S.excludingPattern('https://other.example.dev/', P), null);
});

test('pattern forms: hostnames cover subdomains, URL prefixes stop at a boundary', () => {
  assert.ok(S.patternMatches('example.com', 'https://example.com/'));
  assert.ok(S.patternMatches('example.com', 'https://www.example.com/a'));
  assert.ok(!S.patternMatches('example.com', 'https://notexample.com/'));
  assert.ok(S.patternMatches('*.example.dev', 'https://abc.example.dev/'));
  assert.ok(S.patternMatches('HTTPS://A.dev', 'https://a.dev/x'));
  assert.ok(!S.patternMatches('https://a.dev', 'https://a.dev.evil.com/'));
  assert.ok(S.patternMatches('https://a.dev/docs/', 'https://a.dev/docs/page'));
  assert.ok(!S.patternMatches('https://a.dev/docs/', 'https://a.dev/blog'));
  assert.ok(!S.patternMatches('', 'https://a.dev/'));
});
