"""Readable summary of the EBS's /usage totals, with a month-end forecast for the DDD quota.

    .venv/bin/python scripts/usage-report.py                      (live: fetches /usage)
    .venv/bin/python scripts/usage-report.py --file usage.json    (a saved copy)
    .venv/bin/python scripts/usage-report.py --url https://other-host

Note: fetching /usage is a request like any other, so it wakes the free host if it's asleep.
"""

import argparse
import calendar
import json
import urllib.request
from datetime import date

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
    args = p.parse_args()
    u = load(args)

    today = date.today()
    month = today.strftime("%Y-%m")
    days = [d for d in u["days"] if d["day"].startswith(month)]
    tot = lambda field: sum(d[field] for d in days)

    print(f"Usage report, {today.isoformat()}" + ("" if u["persisted"] else "  (NOT saved: totals cover only the current server process)"))
    print(f"Server process started {u['processStartedAt']}")
    print()
    print(f"This month ({month}, {len(days)} day(s) with traffic):")
    print(f"  Wake-ups                {tot('wakeups'):>8}")
    print(f"  Panel requests          {tot('viewerRequests'):>8}")
    print(f"  Config page requests    {tot('configRequests'):>8}")
    print(f"  Browser preflights      {tot('preflights'):>8}")
    print(f"  Twitch category events  {tot('eventsubNotifications'):>8}")
    print(f"  Other (health, pages)   {tot('otherRequests'):>8}")
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


if __name__ == "__main__":
    main()
