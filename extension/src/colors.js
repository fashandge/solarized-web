/*
 * Solarized Web — color mapping.
 *
 * Maps any CSS color onto the Solarized Light palette while preserving the
 * page's relative lightness ordering (so text stays readable on its
 * background):
 *   - Neutral colors are tone-mapped by OKLab lightness onto a ramp of
 *     Solarized base tones (white -> base3, black -> base02 by default).
 *   - Chromatic colors keep their mapped lightness but snap their hue to the
 *     nearest Solarized accent, with chroma capped at that accent's chroma.
 *   - In "invert" mode (used for pages that are dark by design) lightness is
 *     flipped first, so a dark page also becomes Solarized *Light*.
 *
 * Classic script: defines globalThis.SolarizedColor for the content script
 * and popup, and module.exports for the Node tests.
 */
(function (root) {
  'use strict';

  const PALETTE = {
    base03: '#002b36', base02: '#073642', base01: '#586e75', base00: '#657b83',
    base0: '#839496', base1: '#93a1a1', base2: '#eee8d5', base3: '#fdf6e3',
    yellow: '#b58900', orange: '#cb4b16', red: '#dc322f', magenta: '#d33682',
    violet: '#6c71c4', blue: '#268bd2', cyan: '#2aa198', green: '#859900',
  };

  const DEFAULT_SETTINGS = {
    enabled: true,          // global switch
    // Sites left untouched (see excludingPattern). Typically sites that
    // already ship a proper Solarized Light theme.
    excludePatterns: [
      'http://127.0.0.1:*',
    ],
    contrast: 'normal',     // 'soft' | 'normal' | 'high'
    invertDark: true,       // turn dark-by-design pages into Solarized Light
    tintImages: false,      // warm/dim images and video a little
    canvas: true,           // filter <canvas> (charts, Google Docs) toward Solarized
    font: false,            // force Atkinson Hyperlegible
  };

  /* CSS named colors (CSS4) plus the light-scheme system colors. */
  const NAMED = {aliceblue:"f0f8ff",antiquewhite:"faebd7",aqua:"00ffff",aquamarine:"7fffd4",azure:"f0ffff",beige:"f5f5dc",bisque:"ffe4c4",black:"000000",blanchedalmond:"ffebcd",blue:"0000ff",blueviolet:"8a2be2",brown:"a52a2a",burlywood:"deb887",cadetblue:"5f9ea0",chartreuse:"7fff00",chocolate:"d2691e",coral:"ff7f50",cornflowerblue:"6495ed",cornsilk:"fff8dc",crimson:"dc143c",cyan:"00ffff",darkblue:"00008b",darkcyan:"008b8b",darkgoldenrod:"b8860b",darkgray:"a9a9a9",darkgreen:"006400",darkgrey:"a9a9a9",darkkhaki:"bdb76b",darkmagenta:"8b008b",darkolivegreen:"556b2f",darkorange:"ff8c00",darkorchid:"9932cc",darkred:"8b0000",darksalmon:"e9967a",darkseagreen:"8fbc8f",darkslateblue:"483d8b",darkslategray:"2f4f4f",darkslategrey:"2f4f4f",darkturquoise:"00ced1",darkviolet:"9400d3",deeppink:"ff1493",deepskyblue:"00bfff",dimgray:"696969",dimgrey:"696969",dodgerblue:"1e90ff",firebrick:"b22222",floralwhite:"fffaf0",forestgreen:"228b22",fuchsia:"ff00ff",gainsboro:"dcdcdc",ghostwhite:"f8f8ff",gold:"ffd700",goldenrod:"daa520",gray:"808080",green:"008000",greenyellow:"adff2f",grey:"808080",honeydew:"f0fff0",hotpink:"ff69b4",indianred:"cd5c5c",indigo:"4b0082",ivory:"fffff0",khaki:"f0e68c",lavender:"e6e6fa",lavenderblush:"fff0f5",lawngreen:"7cfc00",lemonchiffon:"fffacd",lightblue:"add8e6",lightcoral:"f08080",lightcyan:"e0ffff",lightgoldenrodyellow:"fafad2",lightgray:"d3d3d3",lightgreen:"90ee90",lightgrey:"d3d3d3",lightpink:"ffb6c1",lightsalmon:"ffa07a",lightseagreen:"20b2aa",lightskyblue:"87cefa",lightslategray:"778899",lightslategrey:"778899",lightsteelblue:"b0c4de",lightyellow:"ffffe0",lime:"00ff00",limegreen:"32cd32",linen:"faf0e6",magenta:"ff00ff",maroon:"800000",mediumaquamarine:"66cdaa",mediumblue:"0000cd",mediumorchid:"ba55d3",mediumpurple:"9370db",mediumseagreen:"3cb371",mediumslateblue:"7b68ee",mediumspringgreen:"00fa9a",mediumturquoise:"48d1cc",mediumvioletred:"c71585",midnightblue:"191970",mintcream:"f5fffa",mistyrose:"ffe4e1",moccasin:"ffe4b5",navajowhite:"ffdead",navy:"000080",oldlace:"fdf5e6",olive:"808000",olivedrab:"6b8e23",orange:"ffa500",orangered:"ff4500",orchid:"da70d6",palegoldenrod:"eee8aa",palegreen:"98fb98",paleturquoise:"afeeee",palevioletred:"db7093",papayawhip:"ffefd5",peachpuff:"ffdab9",peru:"cd853f",pink:"ffc0cb",plum:"dda0dd",powderblue:"b0e0e6",purple:"800080",rebeccapurple:"663399",red:"ff0000",rosybrown:"bc8f8f",royalblue:"4169e1",saddlebrown:"8b4513",salmon:"fa8072",sandybrown:"f4a460",seagreen:"2e8b57",seashell:"fff5ee",sienna:"a0522d",silver:"c0c0c0",skyblue:"87ceeb",slateblue:"6a5acd",slategray:"708090",slategrey:"708090",snow:"fffafa",springgreen:"00ff7f",steelblue:"4682b4",tan:"d2b48c",teal:"008080",thistle:"d8bfd8",tomato:"ff6347",turquoise:"40e0d0",violet:"ee82ee",wheat:"f5deb3",white:"ffffff",whitesmoke:"f5f5f5",yellow:"ffff00",yellowgreen:"9acd32",
    canvas:"ffffff",canvastext:"000000",field:"ffffff",fieldtext:"000000",buttonface:"efefef",buttontext:"000000",buttonborder:"767676",window:"ffffff",windowtext:"000000"};

  /* ---------- sRGB <-> OKLab ---------- */

  const toLinear = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const fromLinear = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

  function rgbToOklab(r, g, b) {
    const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
  }

  function oklabToLinear(L, a, b) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
  }

  const inGamut = (lin) => lin.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

  /* OKLab -> [r,g,b] 0..255, reducing chroma (keeping L and hue) if out of gamut. */
  function oklabToRgb(L, a, b) {
    L = Math.min(1, Math.max(0, L));
    let lin = oklabToLinear(L, a, b);
    if (!inGamut(lin)) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 14; i++) {
        const t = (lo + hi) / 2;
        if (inGamut(oklabToLinear(L, a * t, b * t))) lo = t; else hi = t;
      }
      lin = oklabToLinear(L, a * lo, b * lo);
    }
    return lin.map((c) => Math.round(Math.min(255, Math.max(0, fromLinear(Math.min(1, Math.max(0, c)))))));
  }

  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
    const n = parseInt(hex.slice(0, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }

  const labOf = (hex) => { const [r, g, b] = hexToRgb(hex); return rgbToOklab(r, g, b); };

  /* ---------- parsing ---------- */

  const clamp01 = (x) => Math.min(1, Math.max(0, x));

  function num(tok, percentScale) {
    if (tok === 'none') return 0;
    if (tok.endsWith('%')) return (parseFloat(tok) / 100) * percentScale;
    return parseFloat(tok);
  }

  function hue(tok) {
    if (tok === 'none') return 0;
    const v = parseFloat(tok);
    if (tok.endsWith('turn')) return v * 360;
    if (tok.endsWith('grad')) return v * 0.9;
    if (tok.endsWith('rad')) return (v * 180) / Math.PI;
    return v;
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }

  /*
   * Parse one CSS color token. Returns {lab:[L,a,b], alpha} or null when the
   * token is not a concrete color we understand (var(), calc(), keywords...).
   */
  function parseColor(token) {
    const t = token.trim().toLowerCase();
    if (t[0] === '#') {
      if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(t)) return null;
      const [r, g, b, a] = hexToRgb(t);
      return { lab: rgbToOklab(r, g, b), alpha: a };
    }
    const fn = /^([a-z]+)\((.*)\)$/.exec(t);
    if (!fn) {
      const hex = NAMED[t];
      return hex ? { lab: labOf(hex), alpha: 1 } : null;
    }
    const [, name, body] = fn;
    if (body.includes('from ')) return null; // relative color syntax
    const parts = splitArgs(body);
    if (!parts || parts.length < 3 || parts.length > 4) return null;
    // Channels must be concrete; a var()/calc() alpha is kept verbatim.
    if (parts.slice(0, 3).some((p) => p.includes('('))) return null;
    if (parts.length === 4 && parts[3].includes('(')) {
      const rest = parseColor(`${name}(${parts.slice(0, 3).join(' ')})`);
      return rest && { lab: rest.lab, alpha: 1, alphaExpr: parts[3] };
    }
    const alpha = parts.length === 4 ? clamp01(num(parts[3], 1)) : 1;
    let lab;
    if (name === 'rgb' || name === 'rgba') {
      const [r, g, b] = parts.slice(0, 3).map((p) => clamp01(num(p, 255) / 255) * 255);
      lab = rgbToOklab(r, g, b);
    } else if (name === 'hsl' || name === 'hsla') {
      const [r, g, b] = hslToRgb(hue(parts[0]), clamp01(num(parts[1], 100) / 100), clamp01(num(parts[2], 100) / 100));
      lab = rgbToOklab(r, g, b);
    } else if (name === 'oklch') {
      const L = num(parts[0], 1), C = num(parts[1], 0.4), H = (hue(parts[2]) * Math.PI) / 180;
      lab = [L, C * Math.cos(H), C * Math.sin(H)];
    } else if (name === 'oklab') {
      lab = [num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4)];
    } else {
      return null;
    }
    if (lab.some((x) => !Number.isFinite(x))) return null;
    return { lab, alpha };
  }

  /* Split function arguments on commas, slashes and spaces at nesting depth 0. */
  function splitArgs(body) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of body) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0 && (ch === ',' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n')) {
        if (cur) out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (depth !== 0) return null;
    if (cur) out.push(cur);
    return out;
  }

  function formatRgb([r, g, b], alpha, alphaExpr) {
    if (alphaExpr) return `rgba(${r}, ${g}, ${b}, ${alphaExpr})`;
    if (alpha >= 1) return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
    return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
  }

  /* ---------- mapping ---------- */

  const mixLab = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

  /* Input-lightness anchors -> Solarized tone. Light half is fixed; the dark
   * half depends on the contrast setting. */
  function rampFor(contrast) {
    const P = PALETTE;
    const dark = {
      soft: [[0.55, P.base0], [0.40, P.base00], [0, P.base01]],
      normal: [[0.55, P.base00], [0.40, P.base01], [0, P.base02]],
      high: [[0.55, P.base01], [0.40, '#30525c'], [0, P.base03]],
    }[contrast] || null;
    return [[1, P.base3], [0.93, P.base2], [0.70, P.base1], ...(dark || [])]
      .map(([at, hex]) => ({ at, lab: labOf(hex) }));
  }

  /*
   * Hue warp: the hue of each sRGB primary/secondary is pinned to the hue of
   * the matching Solarized accent and hues in between are interpolated, so a
   * yellow stays yellow (nearest-accent snapping would turn it green).
   */
  const deg = (rad) => ((rad * 180) / Math.PI + 360) % 360;
  const HUE_ANCHORS = [
    ['#ff0000', 'red'], ['#ff8000', 'orange'], ['#ffff00', 'yellow'], ['#00ff00', 'green'],
    ['#00ffff', 'cyan'], ['#0000ff', 'blue'], ['#8000ff', 'violet'], ['#ff00ff', 'magenta'],
  ].map(([src, acc]) => {
    const s = labOf(src), t = labOf(PALETTE[acc]);
    return { from: deg(Math.atan2(s[2], s[1])), to: deg(Math.atan2(t[2], t[1])), C: Math.hypot(t[1], t[2]) };
  }).sort((p, q) => p.from - q.from);

  /* Returns {h (radians), C (max chroma)} for an input hue in radians. */
  function warpHue(h) {
    const x = deg(h), n = HUE_ANCHORS.length;
    for (let i = 0; i < n; i++) {
      const p = HUE_ANCHORS[i], q = HUE_ANCHORS[(i + 1) % n];
      const span = (q.from - p.from + 360) % 360, off = (x - p.from + 360) % 360;
      if (off <= span) {
        const t = span ? off / span : 0;
        const dTo = ((q.to - p.to + 540) % 360) - 180;
        return { h: ((p.to + dTo * t) * Math.PI) / 180, C: p.C + (q.C - p.C) * t };
      }
    }
    return { h, C: 0.12 };
  }

  function createMapper(options = {}) {
    const contrast = ['soft', 'normal', 'high'].includes(options.contrast) ? options.contrast : 'normal';
    const invert = !!options.invert;
    const ramp = rampFor(contrast);
    const cache = new Map();

    function neutral(x) {
      for (let i = 0; i < ramp.length - 1; i++) {
        const hi = ramp[i], lo = ramp[i + 1];
        if (x >= lo.at) return mixLab(lo.lab, hi.lab, (x - lo.at) / (hi.at - lo.at));
      }
      return ramp[ramp.length - 1].lab;
    }

    function mapLab([L, a, b]) {
      // Dark-by-design pages: their background (L ~0.15-0.25) must land on base3.
      const x = invert ? clamp01((1 - L) / 0.82) : clamp01(L);
      const N = neutral(x);
      const C = Math.hypot(a, b);
      const w = smoothstep(0.02, 0.07, C);
      if (w === 0) return N;
      const acc = warpHue(Math.atan2(b, a));
      const Ct = Math.min(C, acc.C);
      return mixLab(N, [N[0], Ct * Math.cos(acc.h), Ct * Math.sin(acc.h)], w);
    }

    /* Map one color token; returns the token unchanged if it isn't a color. */
    function mapColor(token) {
      let out = cache.get(token);
      if (out !== undefined) return out;
      const parsed = parseColor(token);
      out = parsed ? formatRgb(oklabToRgb(...mapLab(parsed.lab)), parsed.alpha, parsed.alphaExpr) : token;
      if (cache.size > 20000) cache.clear();
      cache.set(token, out);
      return out;
    }

    // url(...) is matched first so colors inside it are left alone.
    const TOKEN_RE = /url\([^)]*\)|#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\((?:[^()]|\([^()]*\))*\)|(?<![\w-])[a-zA-Z]+(?![\w(-])/g;

    /* Map every color inside an arbitrary property value (gradients, shadows...). */
    function mapValue(value) {
      if (!value) return value;
      return value.replace(TOKEN_RE, (tok) => (tok.startsWith('url(') ? tok : mapColor(tok)));
    }

    const NON_COLOR_NAME = /size|width|height|space|gap|margin|padding|radius|index|duration|delay|weight|col|row|grid|font|line|opacity|scale|offset|inset|position|translate|rotate|time|count|ratio|z-/i;

    /*
     * Custom properties may hold bare channel lists consumed as rgb(var(--x))
     * or hsl(var(--x)) (Bootstrap, shadcn/ui...). Those are mapped in their
     * own format; everything else goes through mapValue.
     */
    function mapCustomProperty(value, name = '') {
      const t = value.trim();
      let m = /^(\d{1,3})(\s*,\s*|\s+)(\d{1,3})\2(\d{1,3})$/.exec(t);
      if (m && !NON_COLOR_NAME.test(name)) {
        const [r, g, b] = [m[1], m[3], m[4]].map(Number);
        if (r > 255 || g > 255 || b > 255) return value;
        const [R, G, B] = oklabToRgb(...mapLab(rgbToOklab(r, g, b)));
        return [R, G, B].join(m[2].includes(',') ? ', ' : ' ');
      }
      m = /^(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%$/.exec(t);
      if (m) {
        const [r, g, b] = hslToRgb(+m[1], clamp01(m[2] / 100), clamp01(m[3] / 100));
        const [R, G, B] = oklabToRgb(...mapLab(rgbToOklab(r, g, b)));
        const [h, s, l] = rgbToHsl(R, G, B);
        return `${h} ${s}% ${l}%`;
      }
      return mapValue(value);
    }

    return { mapColor, mapValue, mapCustomProperty, contrast, invert };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    const r1 = (x) => Math.round(x * 10) / 10;
    return [r1(h), r1(s * 100), r1(l * 100)];
  }

  /* Relative luminance (WCAG) of a CSS color string, or null. */
  function luminance(token) {
    const p = parseColor(token);
    if (!p) return null;
    const lin = oklabToLinear(...p.lab).map(clamp01);
    return { lum: 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2], alpha: p.alpha };
  }

  /* ---------- site exclusion ---------- */

  const globToRegex = (glob) => glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');

  /*
   * Does one exclusion pattern match a page URL?
   *   - "example.com" / "*.example.com": hostname match; a bare hostname also
   *     covers its subdomains.
   *   - "http://127.0.0.1:*", "https://host/path": URL prefix match, `*` is a
   *     wildcard. A prefix not ending in "/" or "*" must end at a URL
   *     boundary, so "https://a.dev" doesn't match "https://a.dev.evil.com".
   */
  function patternMatches(pattern, url) {
    const p = String(pattern || '').trim().toLowerCase();
    if (!p) return false;
    let u;
    try { u = new URL(url); } catch { return false; }
    if (!p.includes('://')) {
      const host = u.hostname.toLowerCase();
      const re = new RegExp(`^${globToRegex(p)}$`);
      return re.test(host) || (!p.includes('*') && host.endsWith('.' + p));
    }
    const tail = /[/*]$/.test(p) ? '' : '(?:[/:?#]|$)';
    return new RegExp(`^${globToRegex(p)}${tail}`).test(u.href.toLowerCase());
  }

  /* The first pattern excluding `url`, or null. */
  function excludingPattern(url, patterns) {
    for (const p of patterns || []) if (patternMatches(p, url)) return p;
    return null;
  }

  const api = { PALETTE, DEFAULT_SETTINGS, createMapper, parseColor, luminance, patternMatches, excludingPattern };
  root.SolarizedColor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
