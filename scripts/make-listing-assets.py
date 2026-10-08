"""Builds the Developer Console listing images into assets/listing/:

  logo-100.png               Logo Image       100x100 PNG
  discovery-300x200.png      Discovery Image  300x200 PNG (opaque, little text)
  screenshot-{1,2,3}.png     Screenshots      1024x768 PNG (4:3), composed from real panel renders

Run design-preview.py first (it renders the panel states this script composes).

    EXT_NAME="Game Content Warnings" .venv/bin/python scripts/make-listing-assets.py
"""

import base64
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DESIGN = ROOT / "data" / "design"
OUT = ROOT / "assets" / "listing"
NAME = os.environ.get("EXT_NAME", "Game Content Warnings (Unofficial)")
SHORT = NAME.replace("(Unofficial)", "").strip()  # discovery image shows "Unofficial" as a badge
TAGLINE = "Know what's in the game before you watch"

LOGO_SVG = (OUT / "logo.svg").read_text()


def data_uri(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


BASE_CSS = """
* { box-sizing: border-box; margin: 0; }
html, body { width: 100%; height: 100%; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #efeff1; background: #0e0e10;
       -webkit-font-smoothing: antialiased; }
"""


def screenshot_page(title: str, lines: list[str], images: list[tuple[str, str]]) -> str:
    """Left: short caption. Right: real panel renders (318px wide, shown at 1:1 from 2x captures)."""
    imgs = "".join(
        f'<figure><img src="{data_uri(DESIGN / f)}"><figcaption>{cap}</figcaption></figure>' for f, cap in images
    )
    bullets = "".join(f"<li>{l}</li>" for l in lines)
    return f"""<!doctype html><html><head><style>{BASE_CSS}
body {{ display: flex; align-items: center; gap: 30px; padding: 0 34px;
        background: radial-gradient(circle at 20% 20%, #2a2112 0%, #0e0e10 55%); }}
.copy {{ width: 250px; flex: none; }}
.brand {{ display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; color: #f5a524; margin-bottom: 18px; }}
.brand svg {{ width: 34px; height: 34px; }}
h1 {{ font-size: 28px; line-height: 1.15; margin-bottom: 18px; }}
ul {{ padding-left: 18px; color: #c8c8d0; font-size: 15px; line-height: 1.5; }}
li {{ margin-bottom: 8px; }}
.shots {{ display: flex; gap: 20px; }}
figure {{ display: flex; flex-direction: column; align-items: center; gap: 10px; }}
figure img {{ width: 318px; height: auto; border-radius: 10px; border: 1px solid #34343a;
              box-shadow: 0 18px 50px rgba(0,0,0,.55); }}
figcaption {{ font-size: 13px; color: #adadb8; }}
</style></head><body>
<div class="copy"><div class="brand">{LOGO_SVG}<span>{NAME}</span></div><h1>{title}</h1><ul>{bullets}</ul></div>
<div class="shots">{imgs}</div></body></html>"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()

        page = browser.new_page(viewport={"width": 100, "height": 100})
        page.set_content(f"<html><body style='margin:0;background:transparent'>{LOGO_SVG}</body></html>")
        page.locator("svg").screenshot(path=str(OUT / "logo-100.png"), omit_background=True)

        page = browser.new_page(viewport={"width": 300, "height": 200})
        page.set_content(f"""<!doctype html><html><head><style>{BASE_CSS}
body {{ display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
        background: radial-gradient(circle at 50% 30%, #2f2412 0%, #18181b 70%); }}
svg {{ width: 76px; height: 76px; }}
p {{ font-weight: 700; font-size: 19px; letter-spacing: .2px; }}
.badge {{ font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #c8c8d0;
          border: 1px solid #4a4a52; border-radius: 4px; padding: 1px 6px; margin-top: -4px; }}
</style></head><body>{LOGO_SVG}<p>{SHORT}</p><span class="badge">Unofficial</span></body></html>""")
        page.screenshot(path=str(OUT / "discovery-300x200.png"))

        shots = [
            ("Content warnings for the game being streamed",
             ["Confirmed by DoesTheDogDie voters", "Grouped into clear categories", "Updates when the streamer switches games"],
             [("panel-dark-1-collapsed.png", "At a glance"), ("panel-dark-2-open-scrolled.png", "Open a category")]),
            ("Find a specific trigger fast",
             ["Search sits at the top of the panel", "Matches synonyms (“dog” finds “a pet dies”)", "Works in light and dark mode"],
             [("panel-dark-3-search.png", "Search"), ("panel-light-1-collapsed.png", "Light mode")]),
            ("Spoiler-free and to the point",
             ["Only confirmed “Yes” warnings", "No story spoilers, no extra detail", "Streamers can fix a wrong game match"],
             [("panel-light-2-open-scrolled.png", "Just the triggers"), ("panel-dark-4-no-data.png", "Honest when there’s no data")]),
        ]
        page = browser.new_page(viewport={"width": 1024, "height": 768})
        for i, (title, lines, images) in enumerate(shots, 1):
            page.set_content(screenshot_page(title, lines, images))
            page.wait_for_timeout(100)
            page.screenshot(path=str(OUT / f"screenshot-{i}.png"))
        browser.close()
    for f in sorted(OUT.glob("*.png")):
        print(f"  {f.relative_to(ROOT)}  ({f.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
