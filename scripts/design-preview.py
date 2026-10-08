"""Renders the panel exactly as Twitch frames it (318x500 viewport) in every state and
both themes, plus the config page and a phone-width view, into data/design/.
Start the local stack first: bash scripts/local-stack.sh

    .venv/bin/python scripts/design-preview.py
"""

import json
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "design"
BASE = "https://localhost:8080"
MOCK = "http://localhost:8090"
ENV = dict(l.split("=", 1) for l in (ROOT / ".env.mock").read_text().splitlines() if "=" in l and not l.startswith("#"))
CHANNEL = ENV["TWITCH_EXT_OWNER_ID"]


def set_mock_category(game_id: str) -> None:
    q = f"client_id={ENV['TWITCH_EXT_CLIENT_ID']}&client_secret={ENV['TWITCH_EXT_CLIENT_SECRET']}"
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        f"{MOCK}/auth/authorize?{q}&grant_type=user_token&user_id={CHANNEL}&scope=channel:manage:broadcast", method="POST")))
    urllib.request.urlopen(urllib.request.Request(
        f"{MOCK}/mock/channels?broadcaster_id={CHANNEL}", method="PATCH", data=json.dumps({"game_id": game_id}).encode(),
        headers={"Client-Id": ENV["TWITCH_EXT_CLIENT_ID"], "Authorization": f"Bearer {tok['access_token']}", "Content-Type": "application/json"}))


def snap(page: Page, name: str, full: bool = False) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=full)
    print(f"  {name}.png")


# The mock's main item carries The Last of Us's real DDD votes; label it honestly in renders
# (the Twitch CLI mock only offers made-up category names).
REAL_NAME = "The Last of Us"


def relabel(route) -> None:
    resp = route.fetch()
    body = resp.json()
    if isinstance(body, dict) and body.get("category", {}).get("name") == "Just Making a CLI":
        body["category"]["name"] = REAL_NAME
    route.fulfill(response=resp, json=body)


def open_panel(page: Page, theme: str, game: str = "Just Making a CLI") -> None:
    page.route("**/ebs/api/warnings*", relabel)
    page.goto(f"{BASE}/harness/panel.html?channel={CHANNEL}&theme={theme}&game={game}")
    page.locator(".total:visible, .body .state").first.wait_for(timeout=20_000)
    if game == "Just Making a CLI":
        # The EBS may still hold another category for a few seconds; wait for the panel's re-check.
        expect(page.locator(".game")).to_have_text(REAL_NAME, timeout=45_000)
    page.wait_for_timeout(300)


def main() -> None:
    set_mock_category("77827")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for theme in ("dark", "light"):
            ctx = browser.new_context(viewport={"width": 318, "height": 500}, ignore_https_errors=True, device_scale_factor=2)
            page = ctx.new_page()
            open_panel(page, theme)
            snap(page, f"panel-{theme}-1-collapsed")
            page.locator("details.group > summary", has_text="Bodily Harm").click()
            page.mouse.wheel(0, 260)
            page.wait_for_timeout(200)
            snap(page, f"panel-{theme}-2-open-scrolled")
            page.evaluate("window.scrollTo(0, 0)")
            page.locator("#search").fill("dog")
            snap(page, f"panel-{theme}-3-search")
            page.locator("#search").fill("")
            for status, name in (("no_match", "4-no-data"), ("no_category", "5-no-category")):
                data = {"status": status, "category": {"id": "1", "name": "Some Indie Game"}} if status == "no_match" else {"status": status}
                page.evaluate(f"window.__harness.pubsub({{type: 'warnings', data: {json.dumps(data)}}})")
                snap(page, f"panel-{theme}-{name}")
            # Error state: the backend is unreachable when the panel loads.
            err = ctx.new_page()
            err.route("**/ebs/api/warnings*", lambda route: route.abort())
            err.goto(f"{BASE}/harness/panel.html?channel={CHANNEL}&theme={theme}")
            expect(err.locator(".state")).to_contain_text("unavailable", timeout=10_000)
            snap(err, f"panel-{theme}-6-error")
            ctx.close()

        # Phone width (mobile app renders the panel full-width).
        ctx = browser.new_context(viewport={"width": 390, "height": 760}, ignore_https_errors=True, device_scale_factor=2)
        page = ctx.new_page()
        open_panel(page, "dark")
        page.locator("details.group > summary", has_text="Animals").click()
        snap(page, "mobile-dark")
        ctx.close()

        # Broadcaster config page.
        ctx = browser.new_context(viewport={"width": 700, "height": 900}, ignore_https_errors=True, device_scale_factor=1)
        page = ctx.new_page()
        page.goto(f"{BASE}/harness/config.html?channel={CHANNEL}&role=broadcaster")
        expect(page.locator(".status-line")).to_be_visible(timeout=20_000)
        snap(page, "config-dark", full=True)
        ctx.close()
        browser.close()
    print(f"Wrote previews to {OUT.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
