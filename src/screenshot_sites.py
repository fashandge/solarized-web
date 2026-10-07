"""Load the unpacked extension in Chromium and screenshot pages with and without it.

Usage:
    python src/screenshot_sites.py OUT_DIR URL [URL ...] [--only-after] [--wait SECONDS]

For each URL writes OUT_DIR/<slug>-before.png and <slug>-after.png and prints a
JSON line with how many visible elements still have a near-white background.
"""

import argparse
import json
import pathlib
import re
import tempfile

from playwright.sync_api import sync_playwright

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
EXT = pathlib.Path(__file__).resolve().parent.parent / "extension"

# Visible boxes (>= 40x20 px, in the viewport) whose computed background is near white.
WHITE_PROBE = """() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 20 || r.bottom < 0 || r.top > innerHeight) continue;
    const m = getComputedStyle(el).backgroundColor.match(/[\\d.]+/g);
    if (!m) continue;
    const [r0, g, b, a = 1] = m.map(Number);
    if (a > 0.5 && r0 > 245 && g > 245 && b > 245) {
      out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' ' + getComputedStyle(el).backgroundColor);
    }
  }
  const html = document.documentElement;
  return {white: out.length, examples: out.slice(0, 5),
          flags: [...html.attributes].map(a => a.name).filter(n => n.startsWith('data-sz')),
          proxies: document.querySelectorAll('style[data-sz-proxy]').length,
          bodyBg: document.body && getComputedStyle(document.body).backgroundColor};
}"""


def slug(url):
    return re.sub(r"[^a-z0-9]+", "-", url.lower().split("//", 1)[-1])[:60].strip("-")


def shoot(pw, urls, out, with_ext, wait):
    # --user-agent also covers the extension's service worker, whose default
    # "HeadlessChrome" UA gets CSS requests rejected by bot filters.
    args = ["--disable-blink-features=AutomationControlled", f"--user-agent={UA}"]
    if with_ext:
        args += [f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"]
    with tempfile.TemporaryDirectory() as profile:
        ctx = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True, args=args,
            viewport={"width": 1280, "height": 900},
            user_agent=UA,
        )
        if with_ext:
            # Make sure the service worker is up before navigating.
            if not ctx.service_workers:
                ctx.wait_for_event("serviceworker", timeout=10000)
        for url in urls:
            page = ctx.new_page()
            errors = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "sz" in m.text.lower() else None)
            page.on("pageerror", lambda e: errors.append(str(e)) if "content.js" in str(e) else None)
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
            except Exception as e:  # keep going; screenshot whatever loaded
                print(json.dumps({"url": url, "goto_error": str(e)[:200]}))
            page.wait_for_timeout(wait * 1000)
            name = f"{slug(url)}-{'after' if with_ext else 'before'}.png"
            page.screenshot(path=str(out / name))
            info = page.evaluate(WHITE_PROBE) if with_ext else {}
            print(json.dumps({"url": url, "ext": with_ext, "shot": name, **info, "errors": errors[:5]}))
            page.close()
        ctx.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("urls", nargs="+")
    ap.add_argument("--only-after", action="store_true")
    ap.add_argument("--wait", type=float, default=6)
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        if not a.only_after:
            shoot(pw, a.urls, out, False, a.wait)
        shoot(pw, a.urls, out, True, a.wait)


if __name__ == "__main__":
    main()
