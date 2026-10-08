"""End-to-end check of the local mock stack (start it first: bash scripts/local-stack.sh).

Drives the real panel/config pages in headless Chromium through the dev harness and
saves screenshots to data/screenshots/. Exercises:
  - viewer panel states (ok, ok-with-no-confirmed-topics, low_confidence, no_match,
    no_category, error) in dark and light themes
  - search, collapsible broad categories, trigger-only items, freshness line
  - category change via onContext (the path that works without any public EBS)
  - category change via a signed EventSub webhook from the Twitch CLI
  - broadcaster picks a game in the config page; the panel follows

    .venv/bin/python scripts/e2e-local.py
"""

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "data" / "screenshots"
BASE = "https://localhost:8080"
MOCK = "http://localhost:8090"


def env_mock() -> dict:
    out = {}
    for line in (ROOT / ".env.mock").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            out[k] = v
    return out


ENV = env_mock()
CHANNEL = ENV["TWITCH_EXT_OWNER_ID"]


def set_mock_category(game_id: str) -> None:
    """Changes the channel's category in the Twitch CLI mock API (Modify Channel Information)."""
    q = f"client_id={ENV['TWITCH_EXT_CLIENT_ID']}&client_secret={ENV['TWITCH_EXT_CLIENT_SECRET']}"
    tok = json.load(urllib.request.urlopen(urllib.request.Request(
        f"{MOCK}/auth/authorize?{q}&grant_type=user_token&user_id={CHANNEL}&scope=channel:manage:broadcast", method="POST")))
    req = urllib.request.Request(
        f"{MOCK}/mock/channels?broadcaster_id={CHANNEL}",
        method="PATCH",
        data=json.dumps({"game_id": game_id}).encode(),
        headers={"Client-Id": ENV["TWITCH_EXT_CLIENT_ID"], "Authorization": f"Bearer {tok['access_token']}", "Content-Type": "application/json"},
    )
    urllib.request.urlopen(req)


def shot(page: Page, name: str) -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)
    print(f"  screenshot {name}.png")


def panel(page: Page, theme: str = "dark") -> None:
    page.goto(f"{BASE}/harness/panel.html?channel={CHANNEL}&theme={theme}&game=Just%20Making%20a%20CLI")


checks = 0


def check(desc: str) -> None:
    global checks
    checks += 1
    print(f"ok {checks} - {desc}")


def main() -> int:
    set_mock_category("77827")  # "Just Making a CLI"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 318, "height": 500}, ignore_https_errors=True)
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # --- ok state: search on top, broad categories collapsed with counts
        panel(page)
        expect(page.locator("h1")).to_contain_text("Content warnings")
        expect(page.locator(".game")).to_have_text("Just Making a CLI", timeout=20_000)  # cold DDD cache
        expect(page.locator("#search")).to_be_visible()
        expect(page.locator(".total")).to_have_text(" · 85 confirmed")  # 87 Yes minus 2 DDD "Spoiler" topics
        groups = page.locator("details.group")
        expect(groups.first).to_be_visible()
        n_groups = groups.count()
        assert 5 <= n_groups <= 11, n_groups
        expect(page.locator("details.group[open]")).to_have_count(0)
        names = [g.inner_text().split("\n")[0] for g in groups.locator("summary .group-name").all()]
        assert names[-1] == "Other" or "Other" not in names, names
        expect(page.locator(".attribution a")).to_contain_text("Powered by DoesTheDogDie.com")
        expect(page.locator(".attribution a .offsite")).to_have_count(1)
        check(f"ok state: search box on top, {n_groups} collapsed categories with counts, attribution with off-site marker")
        shot(page, "01-panel-collapsed")

        page.locator("details.group > summary", has_text="Animals").click()
        expect(page.locator("details.group[open]")).to_have_count(1)
        animals = page.locator("details.group[open] ul.topics > li")
        assert animals.count() >= 3
        expect(animals.first).to_contain_text("dies")
        check("a category expands to show only its Yes topics")
        shot(page, "02-panel-one-open")

        expect(page.locator("li.topic details, li.topic a, .desc, .votes")).to_have_count(0)
        expect(page.locator("footer a")).to_have_count(2)  # attribution + this game's DDD page
        expect(page.locator(".freshness")).to_have_text("Updated today")
        check("items show just the trigger; freshness line")

        expect(page.locator("h1 .badge")).to_have_text("Unofficial")
        expect(page.locator(".disclaimer")).to_have_text("Unofficial: not affiliated with or endorsed by DoesTheDogDie.com.")
        last_link = page.locator("footer a").last
        expect(last_link).to_contain_text("Just Making a CLI on DoesTheDogDie")
        expect(last_link).to_have_attribute("href", "https://www.doesthedogdie.com/media/9001")
        expect(last_link).to_have_attribute("target", "_blank")
        check("'Unofficial' badge + non-affiliation line; game's DDD page linked at the very bottom (new tab, off-site marker)")

        page.get_by_role("button", name="Expand all").click()
        expect(page.locator("details.group[open]")).to_have_count(n_groups)
        expect(page.get_by_role("button", name="Collapse all")).to_be_visible()
        check("expand all / collapse all")
        shot(page, "03-panel-all-open")
        page.get_by_role("button", name="Collapse all").click()

        page.locator("#search").fill("dog")
        visible_topics = page.locator("ul.topics > li")
        expect(visible_topics).to_have_count(2)
        expect(page.locator("ul.topics")).to_contain_text("A pet dies")  # matched via DDD keywords
        expect(page.locator("#search")).to_be_focused()
        check("search matches names and DDD keywords ('dog' finds 'a pet dies'), opens categories, keeps focus")
        shot(page, "04-panel-search")
        page.locator("#search").fill("spider")
        expect(page.locator(".groups .state")).to_contain_text("No confirmed warning matches")
        check("search with no hits explains that absence isn't a guarantee")
        page.locator("#search").fill("")

        panel(page, theme="light")
        page.locator("details.group > summary", has_text="Violence").click()
        shot(page, "05-panel-light")


        # --- category change seen via onContext (no EventSub needed)
        set_mock_category("46068")  # "Just Developing"
        page.evaluate("window.__harness.setGame('Just Developing')")
        expect(page.locator(".game")).to_have_text("Just Developing", timeout=45_000)
        expect(page.locator(".state")).to_contain_text("No content warnings have been confirmed")
        check("onContext category change -> panel updates (with EBS cache lag retry)")
        shot(page, "07-panel-none-confirmed")

        # --- category change pushed by EventSub (signed webhook from the Twitch CLI)
        out = subprocess.run(
            [str(ROOT / ".venv/bin/twitch"), "event", "trigger", "channel.update", "-v", "2", "-t", CHANNEL,
             "-G", "53446", "-n", "Development Test", "-F", "http://127.0.0.1:8081/eventsub", "-s", ENV["EVENTSUB_SECRET"]],
            capture_output=True, text=True, check=True,
        )
        assert "Request Sent" in out.stdout + out.stderr or "202" in out.stdout + out.stderr or out.returncode == 0, out
        time.sleep(1)
        page.reload()  # served from the EBS view EventSub just updated (no Helix re-check needed)
        expect(page.locator(".game")).to_have_text("Development Test", timeout=10_000)
        set_mock_category("53446")  # like real Twitch, Helix now agrees (keeps later steps stable past the 90 s cache)
        expect(page.locator(".game")).to_have_text("Development Test", timeout=10_000)
        expect(page.locator(".state")).to_have_text("No content warning data found for this category.")
        check("EventSub channel.update (HMAC-signed) updates the EBS view immediately")
        shot(page, "08-panel-low-confidence")

        # --- states injected over the PubSub listener path
        page.evaluate("window.__harness.pubsub({type: 'warnings', data: {status: 'no_category'}})")
        expect(page.locator(".state")).to_contain_text("No category is set")
        shot(page, "09-panel-no-category")
        check("PubSub broadcast messages re-render the panel")
        page.evaluate("window.__harness.pubsub({type: 'warnings', data: {status: 'error'}})")
        page.wait_for_timeout(300)
        expect(page.locator(".state")).to_contain_text("No category is set")
        check("a transient error never replaces data the viewer already has")

        # --- backend unreachable from the start: error state, then automatic retry
        err_page = ctx.new_page()
        err_page.route("**/ebs/api/warnings*", lambda route: route.abort())
        # Same game the EBS currently has (from the EventSub step), so this page doesn't change channel state.
        err_page.goto(f"{BASE}/harness/panel.html?channel={CHANNEL}&game=Development%20Test")
        expect(err_page.locator(".state")).to_contain_text("unavailable right now", timeout=10_000)
        expect(err_page.locator(".state")).to_contain_text("Trying again")
        shot(err_page, "10-panel-error")
        err_page.unroute("**/ebs/api/warnings*")
        expect(err_page.locator(".game")).to_be_visible(timeout=30_000)  # retried after ~15 s
        expect(err_page.locator(".body")).not_to_contain_text("unavailable")
        err_page.close()
        check("unreachable backend shows a retrying error, then recovers on its own")

        # --- broadcaster resolves the ambiguous match in the config page
        cfg = ctx.new_page()
        cfg.set_viewport_size({"width": 640, "height": 800})
        cfg.goto(f"{BASE}/harness/config.html?channel={CHANNEL}&role=broadcaster")
        expect(cfg.locator("section").first).to_contain_text("several possible matches")
        expect(cfg.locator("ul.choices li")).to_have_count(2)
        shot(cfg, "11-config-low-confidence")
        cfg.locator("ul.choices li", has_text="2022").get_by_role("button", name="Use this").click()
        expect(cfg.locator(".message")).to_contain_text("Saved")
        expect(cfg.locator("section").first).to_contain_text("Using your choice")
        check("broadcaster override saved through EBS")
        cfg.get_by_label("Wrong game? Search for the right one:").fill("just making")
        cfg.get_by_role("button", name="Search").click()
        expect(cfg.locator("ul.choices li", has_text="(not a video game)")).to_have_count(1)
        expect(cfg.get_by_label("Wrong game? Search for the right one:")).to_have_value("just making")
        expect(cfg.get_by_label("Wrong game? Search for the right one:")).to_be_focused()
        shot(cfg, "12-config-search")
        check("broadcaster search lists games first, labels non-games, keeps the typed text and focus")

        page.reload()
        expect(page.locator(".game")).to_have_text("Development Test")
        expect(page.locator(".state")).to_contain_text("No content warnings have been confirmed")
        check("panel follows the broadcaster's override")

        # --- non-game category
        cfg.get_by_role("button", name="Use automatic matching").click()
        expect(cfg.locator(".message")).to_contain_text("automatic")
        set_mock_category("78544")  # Just Chatting
        page.evaluate("window.__harness.setGame('Just Chatting')")
        expect(page.locator(".game")).to_have_text("Just Chatting", timeout=45_000)
        expect(page.locator(".state")).to_have_text("No content warning data found for this category.")
        check("non-game category -> no data (no false match)")
        shot(page, "13-panel-just-chatting")

        if errors:
            print("page errors:", errors)
            return 1
        browser.close()
    print(f"\nAll {checks} checks passed. Screenshots in {SHOTS.relative_to(ROOT)}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
