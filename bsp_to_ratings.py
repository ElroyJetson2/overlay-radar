#!/usr/bin/env python3
"""
Turn Betfair's free BSP CSVs into data/horse_model.json (no paid data, standard library only).

Source: https://promo.betfair.com/betfairsp/prices  (files like dwbfpricesauswin12102026.csv)
Columns used: EVENT_ID, EVENT_DT, SELECTION_NAME, WIN_LOSE, BSP

What it learns
  1. b  - calibration exponent. Market win prob p (from 1/BSP, normalised per race) is re-weighted as p^b and
          renormalised. b > 1 means favourites win more often than the price implies, b < 1 the reverse.
  2. r  - per-horse residual vs the market (multinomial/softmax Elo): utility = b*ln(p) + r. A horse that keeps
          beating its BSP drifts positive. This is the classic "fundamental + public odds" blend, using only results.

Honesty check: predictions are scored prequentially (predict race, then learn from it). Log loss is reported on
the last 20% of races for market-only, calibrated, and calibrated+residual. The Worker only uses the residual
(useResidual=true) if it beats calibrated-market by a margin out of sample. BSP is an efficient price, so
expect that to be hard; if it isn't beaten you still get the calibration exponent.

Usage
  python scripts/bsp_to_ratings.py --days 240
  python scripts/bsp_to_ratings.py --cache .cache/bsp --no-download     # use cached files only
"""
import argparse, csv, io, json, math, os, re, sys, time, urllib.request, urllib.error
from datetime import date, datetime, timedelta, timezone

BASE = "https://promo.betfair.com/betfairsp/prices/"


def norm(s):  # keep identical to nm() in worker/index.js
    s = re.sub(r"^\s*\d+\.\s*", "", s or "")
    s = re.sub(r"\(.*?\)", "", s)
    return re.sub(r"[^a-z0-9]", "", s.lower())


def fetch_day(d, cache, country, download):
    name = f"dwbfprices{country}win{d.strftime('%d%m%Y')}.csv"
    path = os.path.join(cache, name)
    if os.path.exists(path):
        return path if os.path.getsize(path) > 0 else None
    if not download:
        return None
    os.makedirs(cache, exist_ok=True)
    for attempt in range(3):
        try:
            req = urllib.request.Request(BASE + name, headers={"User-Agent": "overlay-radar-model/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            open(path, "wb").write(data)
            time.sleep(0.25)  # be polite
            return path if data.strip() else None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                open(path, "wb").write(b"")  # remember the miss
                return None
            time.sleep(1 + attempt)
        except Exception:
            time.sleep(1 + attempt)
    return None


def parse_dt(s):
    for f in ("%d-%m-%Y %H:%M", "%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M:%S", "%d-%m-%Y %H:%M:%S", "%d/%m/%Y %H:%M:%S"):
        try:
            return datetime.strptime((s or "").strip(), f)
        except ValueError:
            pass
    return datetime.min


def load_races(paths):
    races = []
    for day_index, path in enumerate(paths):
        by = {}
        with open(path, newline="", encoding="utf-8", errors="replace") as fh:
            for row in csv.DictReader(fh):
                try:
                    bsp = float(row.get("BSP") or 0)
                except ValueError:
                    continue
                if bsp <= 1.0 or not row.get("SELECTION_NAME") or not row.get("EVENT_ID"):
                    continue
                by.setdefault(row["EVENT_ID"], {"dt": parse_dt(row.get("EVENT_DT")), "r": []})["r"].append(
                    (norm(row["SELECTION_NAME"]), bsp, 1 if (row.get("WIN_LOSE") or "").strip() == "1" else 0))
        for ev in by.values():
            rs = ev["r"]
            if len(rs) >= 4 and sum(w for _, _, w in rs) == 1 and all(n for n, _, _ in rs):
                races.append((day_index, ev["dt"], rs))
    races.sort(key=lambda x: (x[0], x[1]))
    return races


def mkt(rs):
    inv = [1.0 / b for _, b, _ in rs]
    s = sum(inv)
    return [x / s for x in inv]


def softmax(u):
    m = max(u)
    e = [math.exp(x - m) for x in u]
    s = sum(e)
    return [x / s for x in e]


def race_ll(rs, b, resid=None):
    p = mkt(rs)
    u = [b * math.log(max(x, 1e-9)) + (resid.get(n, 0.0) if resid else 0.0) for x, (n, _, _) in zip(p, rs)]
    q = softmax(u)
    return -math.log(max(q[[w for _, _, w in rs].index(1)], 1e-12))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=240)
    ap.add_argument("--end", default=None, help="last date YYYY-MM-DD (default: yesterday)")
    ap.add_argument("--country", default="aus", help="file prefix: aus, uk, ire, nz not available separately")
    ap.add_argument("--cache", default=".cache/bsp")
    ap.add_argument("--out", default="data/horse_model.json")
    ap.add_argument("--no-download", action="store_true")
    ap.add_argument("--lr", type=float, default=0.12, help="residual learning rate")
    ap.add_argument("--clip", type=float, default=1.0, help="max |residual|")
    ap.add_argument("--min-runs", type=int, default=3)
    ap.add_argument("--inspect", action="store_true", help="download the latest available file and print what the parser sees, then exit")
    a = ap.parse_args()

    end = date.fromisoformat(a.end) if a.end else date.today() - timedelta(days=1)
    if a.inspect:
        for i in range(0, 10):
            d = end - timedelta(days=i)
            p = fetch_day(d, a.cache, a.country, not a.no_download)
            if p:
                print("file:", p)
                lines = open(p, encoding="utf-8", errors="replace").read().splitlines()
                print("\n".join(lines[:7]))
                rs = load_races([p])
                print(f"parsed races: {len(rs)}")
                if rs:
                    print("sample runners (normalised):", [(n, b, w) for n, b, w in rs[0][2][:5]])
                return
        sys.exit("No file found in the last 10 days (download blocked? check network access to promo.betfair.com)")
    paths = []
    for i in range(a.days, -1, -1):
        p = fetch_day(end - timedelta(days=i), a.cache, a.country, not a.no_download)
        if p:
            paths.append(p)
    races = load_races(paths)
    print(f"files: {len(paths)}  usable races: {len(races)}", file=sys.stderr)
    if len(races) < 200:
        sys.exit("Not enough races to train (need 200+). Increase --days or check the cache.")

    cut = int(len(races) * 0.8)
    # 1) calibration exponent b on the training part only
    grid = [round(0.70 + 0.01 * i, 2) for i in range(61)]
    b = min(grid, key=lambda g: sum(race_ll(rs, g) for _, _, rs in races[:cut]))

    # 2) prequential pass: predict, score (holdout only), then learn
    resid, runs = {}, {}
    ll_mkt = ll_cal = ll_mod = 0.0
    n_hold = 0
    for idx, (_, _, rs) in enumerate(races):
        if idx >= cut:
            ll_mkt += race_ll(rs, 1.0)
            ll_cal += race_ll(rs, b)
            ll_mod += race_ll(rs, b, resid)
            n_hold += 1
        p = mkt(rs)
        q = softmax([b * math.log(max(x, 1e-9)) + resid.get(n, 0.0) for x, (n, _, _) in zip(p, rs)])
        for qi, (n, _, w) in zip(q, rs):
            r = resid.get(n, 0.0) + a.lr * (w - qi)
            resid[n] = max(-a.clip, min(a.clip, r))
            runs[n] = runs.get(n, 0) + 1
    ev = {"holdout_races": n_hold, "logloss_market": round(ll_mkt / n_hold, 5), "logloss_calibrated": round(ll_cal / n_hold, 5),
          "logloss_model": round(ll_mod / n_hold, 5)}
    use = ev["logloss_model"] < ev["logloss_calibrated"] - 0.0005
    ev["useResidual"] = use
    out = {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "days": a.days, "races": len(races), "b": b, "useResidual": use,
           "eval": ev, "horses": {n: [round(r, 3), runs[n]] for n, r in resid.items() if runs[n] >= a.min_runs and abs(r) > 0.01}}
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(json.dumps({k: out[k] for k in ("updated", "races", "b", "useResidual", "eval")}, indent=1))
    print(f"horses stored: {len(out['horses'])}", file=sys.stderr)


if __name__ == "__main__":
    main()
