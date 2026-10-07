# Solarized Web

A Chrome extension (Manifest V3) that recolors every web page with the
Solarized Light palette — white backgrounds become `#fdf6e3`, black text
becomes `#073642` — regardless of the page's original styling.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Optional: for local `file://` pages, enable "Allow access to file URLs".

Tabs that were already open are recolored on install; no reload needed.

## Use

Toolbar popup: per-site switch, text contrast (Soft / Normal / High),
"Turn dark sites light", "Recolor canvas", "Soften images & video",
"Atkinson Hyperlegible font", and a global switch. Changes apply live.
Shortcut **⌥⇧S** toggles the current site (rebind at `chrome://extensions/shortcuts`).

**Excluded sites** (popup list) are left untouched — e.g. sites that already
ship a proper Solarized Light theme. An entry is either a hostname, which also
covers its subdomains (`example.com`, `*.example.com`), or a URL prefix where
`*` is a wildcard (`http://127.0.0.1:*`). Default: `http://127.0.0.1:*`.
The per-site switch and ⌥⇧S add or remove hostname entries in the same list.

## How it works

`extension/src/content.js` rewrites the page's CSS **in place** rather than
patching computed styles, so `:hover`, media queries and pseudo-elements keep
working:

- Every rule of every stylesheet — nested `@media`/`@supports`/`@layer`,
  keyframes, adopted sheets, open and closed shadow roots — has its color
  properties and color-bearing custom properties remapped.
- Cross-origin stylesheets (hidden from the CSSOM) are fetched by the
  background worker and swapped for an identical same-origin `<style>`. Only
  `text/css` responses are used and no cookies are sent, since the text
  becomes readable by the page. `@import`s are inlined with their `layer()`,
  `supports()` and media conditions; if any import can't be inlined, the
  original stylesheet is left in place.
- CSS-in-JS rules inserted via `insertRule` are caught by a per-frame check
  that runs for a second after elements are added (document-level sheets);
  shadow-root sheets and anything else are caught by a 1.5 s poll. Inline
  `style=""`, `bgcolor`, `<font color>` and SVG `fill`/`stroke` are handled
  through a MutationObserver.
- Idle pages cost nothing: no per-frame work without DOM insertions, and no
  references are kept to replaced stylesheets or removed shadow trees.
- A newer copy of the content script (after an extension reload) tells the
  older one to restore the page and retire; a rate limit stops any
  tug-of-war over a value at 20 rewrites per second.
- `@media (prefers-color-scheme: dark)` is neutralized; pages that are dark by
  design are detected and inverted to light.
- `<canvas>` (charts, Google Docs) can't be recolored, so it gets a CSS filter
  that pulls white toward base3.

`extension/src/colors.js` does the mapping in OKLab: neutrals are tone-mapped
onto the Solarized base ramp (order preserved, so contrast survives), chromatic
colors keep their lightness and are hue-warped onto the Solarized accents.

## Limitations

- Images and video are not recolored (enable "Soften images & video" to dim them).
- Chrome's internal pages, the Web Store and the built-in PDF viewer can't be
  touched by extensions.
- A cross-origin stylesheet stays unrecolored if its host refuses the
  extension's fetch, it isn't served as `text/css`, or one of its `@import`s
  can't be fetched.
- A page script editing an already-recolored rule through the CSSOM isn't
  recolored again; closed shadow roots on built-in elements (`div`) are
  missed; CSS-in-JS rules added on a class change, with no element insertion,
  can take up to 1.5 s to be recolored.

## Development

```sh
node --test tests/*.test.js                       # color-mapping unit tests
python src/screenshot_sites.py OUT_DIR URL...     # before/after screenshots + white-box count
```

`screenshot_sites.py` needs Playwright (`ml` conda env). It loads the unpacked
extension in headless Chromium and reports, per page, how many visible boxes
still have a near-white background.
