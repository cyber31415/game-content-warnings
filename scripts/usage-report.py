"""Readable summary of the EBS's /usage totals, with a month-end forecast for the DDD quota.

    .venv/bin/python scripts/usage-report.py                      (live: fetches /usage)
    .venv/bin/python scripts/usage-report.py --file usage.json    (a saved copy)
    .venv/bin/python scripts/usage-report.py --url https://other-host
    .venv/bin/python scripts/usage-report.py --save before.json           (keep a snapshot, e.g. before a stream)
    .venv/bin/python scripts/usage-report.py --since before.json          (what happened since that snapshot)

Note: fetching /usage is a request like any other, so it wakes the free host if it's asleep.
"""

import argparse
import calendar
import json
import urllib.request
from datetime import datetime, timezone

DEFAULT_URL = "https://game-content-warnings.onrender.com"


def load(args: argparse.Namespace) -> dict:
    if args.file:
        with open(args.file, encoding="utf-8") as f:
            return json.load(f)
    with urllib.request.urlopen(f"{args.url.rstrip('/')}/usage", timeout=90) as r:
        return json.load(r)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default=DEFAULT_URL)
    p.add_argument("--file")
    p.add_argument("--save", help="also write the raw /usage data to this file, with the time it was taken")
    p.add_argument("--since", help="report only the change since a snapshot made with --save")
    args = p.parse_args()
    u = load(args)
    if args.save:
        with open(args.save, "w", encoding="utf-8") as f:
            json.dump({**u, "snapshotTakenAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}, f, indent=2)
        print(f"Saved snapshot to {args.save}")
    if args.since:
        with open(args.since, encoding="utf-8") as f:
            before = json.load(f)
        if "snapshotTakenAt" not in before:
            raise SystemExit(f"{args.since} is not a snapshot: make one with --save")
        since(before, u)
        return

    today = datetime.now(timezone.utc).date()  # /usage days are UTC
    month = today.strftime("%Y-%m")
    days = [d for d in u["days"] if d["day"].startswith(month)]
    tot = lambda field: sum(d.get(field, 0) for d in days)

    print(f"Usage report, {today.isoformat()}" + ("" if u["persisted"] else "  (NOT saved: totals cover only the current server process)"))
    print(f"Server process started {u['processStartedAt']}")
    print()
    print(f"This month ({month}, {len(days)} day(s) with traffic):")
    print(f"  Wake-ups                {tot('wakeups'):>8}")
    print(f"  Panel requests          {tot('viewerRequests'):>8}")
    print(f"  Config page requests    {tot('configRequests'):>8}")
    print(f"  Browser preflights      {tot('preflights'):>8}")
    print(f"  Twitch category events  {tot('eventsubNotifications'):>8}")
    print(f"  Other (pages, /usage)   {tot('otherRequests'):>8}")
    print(f"  Host health checks      {tot('healthChecks'):>8}  (not counted in data sent)")
    print(f"  Data sent               {tot('bytesSent') / 1_048_576:>8.1f} MB")
    print(f"  DoesTheDogDie requests  {tot('dddRequests'):>8}")

    q = u.get("dddQuota") or {}
    left, limit = q.get("remainingMonth"), q.get("limitMonth")
    if left is not None and limit:
        used = limit - left
        days_in_month = calendar.monthrange(today.year, today.month)[1]
        # DDD's own count covers every request this month (including ones before usage tracking).
        pace = used / today.day * days_in_month
        print()
        print(f"DoesTheDogDie allowance: {used} of {limit} used, {left} left (DDD's own count)")
        print(f"  At this month's pace: ~{pace:.0f} by month end ({pace / limit:.0%} of the allowance)")

    c = u["cache"]
    print()
    print(f"Saved: {c['matchedGames']} matched game(s), {c['otherCategories']} other categor(ies), {c['savedItems']} game warning list(s)")

    if days:
        print()
        print("Per day (newest first):  day         wakes  panel  DDD   MB")
        for d in days[:14]:
            print(f"                         {d['day']}  {d['wakeups']:>5}  {d['viewerRequests']:>5}  {d['dddRequests']:>3}  {d['bytesSent'] / 1_048_576:5.2f}")


def since(before: dict, after: dict) -> None:
    """Change in every counter between two snapshots (sums all saved days, so streams that cross
    midnight UTC are counted whole)."""
    fields = ["wakeups", "viewerRequests", "configRequests", "preflights", "eventsubNotifications",
              "otherRequests", "healthChecks", "bytesSent", "dddRequests"]
    total = lambda u, f: sum(d.get(f, 0) for d in u["days"])
    start = datetime.fromisoformat(before["snapshotTakenAt"])
    hours = (datetime.now(timezone.utc) - start).total_seconds() / 3600
    print(f"Change since {before['snapshotTakenAt']} ({hours:.1f} h ago):")
    labels = {"wakeups": "Wake-ups", "viewerRequests": "Panel requests", "configRequests": "Config page requests",
              "preflights": "Browser preflights", "eventsubNotifications": "Twitch category events",
              "otherRequests": "Other (pages, /usage)", "healthChecks": "Host health checks", "dddRequests": "DoesTheDogDie requests"}
    for f in fields:
        d = total(after, f) - total(before, f)
        if f == "bytesSent":
            print(f"  {'Data sent':<24}{d / 1_048_576:>9.2f} MB")
        else:
            print(f"  {labels[f]:<24}{d:>9}")
    b, a = (before.get("dddQuota") or {}).get("remainingMonth"), (after.get("dddQuota") or {}).get("remainingMonth")
    if b is not None and a is not None:
        if a > b:
            print(f"  DoesTheDogDie's own count: reset between the snapshots (monthly allowance), {a} left now")
        else:
            print(f"  DoesTheDogDie's own count: {b - a} used ({a} left)")
    print("  (/usage keeps the last 31 days; snapshots further apart than that undercount)")


if __name__ == "__main__":
    main()
