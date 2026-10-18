#!/usr/bin/env python3
"""
Sectionals -> per-runner ratings, hidden-ability flags and run styles, from Racing Queensland's free sectional CSVs.
Standard library only. Works for thoroughbreds (verified format) and greyhounds / harness (same parser, see --inspect).

Source pages list one CSV per meeting, e.g. RacingFile.ashx?path=/Sectional/20261017_Doomben_T.csv
File format (verified on a real file): a header line per race
    Date,RaceNumber,<date>;<meeting>;<race name>;<winner time>;<TRACK_DIST>
then one line per runner:
    <date>,<race no>,<name>;<number>;<marker>;<speed m/s>;<section time>;<marker>;...   (all-zero rows = scratched / no data)

What it learns (no results or odds needed; the winner is the runner with the lowest total time):
  idx    = alpha * closing-speed z-score + (1-alpha) * overall-time z-score, within each race's field
  rating = recency-weighted mean of a runner's last 5 idx values; win probability = softmax(beta * rating) across the field.
           Because it is relative to the field, a weak field raises a good runner's chance automatically.
  hidden ability ("masked"): ran a top-20% closing speed but finished in the bottom half. Flagged only if, out of sample,
           flagged runners really did win next start more often than chance (useMasked).
  style  = L / P / M / OM / BM from first-section speed rank over the last 3 runs (feeds the pace map).
Honesty gate: alpha/beta are fitted on the first 70% of races; the last 30% are scored prequentially against a no-information
baseline. useSectionals is only true if the model beats it by a clear margin.

Usage
  python scripts/sectionals_model.py --inspect                   # check the real file layout parses
  python scripts/sectionals_model.py --code thoroughbred --days 150
  python scripts/sectionals_model.py --code greyhound --days 150 # greyhound page URL is unverified: override with --page-url
"""
import argparse, json, math, os, re, statistics, sys, time, urllib.request
from datetime import datetime, timezone

RQ = "https://www.racingqueensland.com.au"
PAGES = {"thoroughbred": RQ + "/industry/thoroughbred/thoroughbred-sectionals",
         "harness": RQ + "/industry/harness/harness-sectionals",
         "greyhound": RQ + "/industry/greyhound/greyhound-sectionals"}  # greyhound page: by analogy, UNVERIFIED
LINK = re.compile(r"RacingFile\.ashx\?path=(/Sectional/(\d{8})_[^\"'<>\s)]+?\.csv)", re.I)
CLOSE = {"thoroughbred": 2, "harness": 2, "greyhound": 1}   # how many final sections count as "closing"
MIN_FIELD = {"thoroughbred": 5, "harness": 5, "greyhound": 6}
ALPHAS = [0, .25, .5, .75, 1]
BETAS = [.2, .4, .6, .8, 1.0, 1.3, 1.6, 2.0]


def norm(s):  # keep identical to nm() in worker/index.js
    s = re.sub(r"^\s*\d+\.\s*", "", s or "")
    s = re.sub(r"\(.*?\)", "", s)
    return re.sub(r"[^a-z0-9]", "", s.lower())


def get(url, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": "overlay-radar-model/1.0 (personal use)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def tsec(s):
    h, m, x = s.split(":")
    return int(h) * 3600 + int(m) * 60 + float(x)


def parse_csv(text):
    races, cur = [], None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("Date,RaceNumber,"):
            meta = line.split(",", 2)[2].split(";")      # race names can contain commas, so only split twice
            m = re.search(r"_(\d+)m", meta[-1])
            cur = {"no": None, "name": meta[2] if len(meta) > 2 else "", "dist": int(m.group(1)) if m else 0, "runners": []}
            races.append(cur)
            continue
        if cur is None:
            continue
        p = line.split(",", 2)
        if len(p) < 3:
            continue
        f = p[2].split(";")
        try:
            cur["no"] = int(p[1])
            segs = f[2:]
            sec = [(float(segs[i]), float(segs[i + 1]), tsec(segs[i + 2])) for i in range(0, len(segs) - 2, 3)]
            num = int(f[1])
        except (ValueError, IndexError):
            continue
        if sec and any(t > 0 for _, _, t in sec):         # all-zero rows are scratchings
            cur["runners"].append({"name": f[0], "no": num, "sec": sec})
    return [r for r in races if r["no"] is not None]


def z(x, xs):
    sd = statistics.pstdev(xs) or 1e-6
    return max(-3, min(3, (x - statistics.fmean(xs)) / sd))


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def analyse(r, code):
    rs = r["runners"]
    n = len(rs)
    if n < MIN_FIELD[code] or len({len(h["sec"]) for h in rs}) != 1:
        return None
    k = CLOSE[code]
    tot = [sum(t for _, _, t in h["sec"]) for h in rs]
    cls = [statistics.fmean(s for _, s, _ in h["sec"][-k:]) for h in rs]
    early = [h["sec"][0][1] for h in rs]
    for i, h in enumerate(rs):
        h["total"], h["perf_z"], h["close_z"] = tot[i], z(-tot[i], [-t for t in tot]), z(cls[i], cls)
    for key, vals in (("rank", [-t for t in tot]), ("close_rank", cls), ("early_rank", early)):
        order = sorted(range(n), key=lambda i: -vals[i])
        for pos, i in enumerate(order):
            rs[i][key] = pos + 1
    for h in rs:
        h["early_pct"] = (h["early_rank"] - 0.5) / n
        h["masked"] = h["close_rank"] <= max(2, round(n * 0.2)) and h["rank"] > math.ceil(n * 0.5)
        h["n"] = n
    return r


def style_of(runs):
    e = statistics.fmean(x["early_pct"] for x in runs[-3:])
    return "L" if e <= .2 else "P" if e <= .4 else "M" if e <= .65 else "OM" if e <= .85 else "BM"


def rating(runs, alpha):
    last = runs[-5:]
    w = [0.7 ** (len(last) - 1 - i) for i in range(len(last))]
    return sum(wi * (alpha * x["close_z"] + (1 - alpha) * x["perf_z"]) for wi, x in zip(w, last)) / sum(w)


def softmax_ll(rs, ratings, beta):
    known = [v for v in ratings if v is not None]
    mean = statistics.fmean(known)
    u = [beta * (v if v is not None else mean) for v in ratings]
    m = max(u)
    e = [math.exp(x - m) for x in u]
    win = next(i for i, h in enumerate(rs) if h["rank"] == 1)
    return -math.log(max(e[win] / sum(e), 1e-12))


def run_pass(races, alpha):
    """Walk races in time order; return per-race pre-race ratings (None when <2 prior runs) and final history."""
    hist, out = {}, []
    for r in races:
        pre = []
        for h in r["runners"]:
            runs = hist.get(norm(h["name"]), [])
            pre.append(rating(runs, alpha) if len(runs) >= 2 else None)
        out.append(pre)
        for h in r["runners"]:
            hist.setdefault(norm(h["name"]), []).append(h)
    return out, hist


def discover(code, page_url, cache, download):
    os.makedirs(cache, exist_ok=True)
    cp = os.path.join(cache, f"_page_{code}.html")
    html = None
    if download:
        try:
            html = get(page_url)
            open(cp, "w", encoding="utf-8").write(html)
        except Exception as e:
            print(f"could not fetch {page_url}: {e}", file=sys.stderr)
    if html is None and os.path.exists(cp):
        html = open(cp, encoding="utf-8").read()
    if not html:
        sys.exit(f"No sectionals page available for '{code}'. Check the URL with --page-url or network access.")
    found = {}
    for path, d in LINK.findall(html):
        found[path] = d
    return sorted(found.items(), key=lambda x: x[1])


def load(code, links, cache, download, days, end):
    races = []
    cut = (end - __import__("datetime").timedelta(days=days)).strftime("%Y%m%d")
    for path, d in links:
        if d < cut or d > end.strftime("%Y%m%d"):
            continue
        fp = os.path.join(cache, path.split("/")[-1])
        if not os.path.exists(fp):
            if not download:
                continue
            try:
                open(fp, "w", encoding="utf-8").write(get(RQ + "/RacingFile.ashx?path=" + path))
                time.sleep(0.3)
            except Exception as e:
                print("skip", path, e, file=sys.stderr)
                continue
        for r in parse_csv(open(fp, encoding="utf-8", errors="replace").read()):
            a = analyse(r, code)
            if a:
                a["date"] = d
                races.append(a)
    races.sort(key=lambda r: (r["date"], r["no"]))
    return races


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--code", default="thoroughbred", choices=list(PAGES))
    ap.add_argument("--days", type=int, default=150)
    ap.add_argument("--page-url", default=None)
    ap.add_argument("--cache", default=".cache/sectionals")
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-download", action="store_true")
    ap.add_argument("--inspect", action="store_true")
    ap.add_argument("--keep-days", type=int, default=150, help="drop runners whose last run is older than this")
    a = ap.parse_args()
    download = not a.no_download
    out = a.out or ("data/sectional_model.json" if a.code == "thoroughbred" else f"data/sectional_model_{a.code}.json")
    links = discover(a.code, a.page_url or PAGES[a.code], a.cache, download)
    print(f"{a.code}: {len(links)} sectional files listed", file=sys.stderr)
    end = datetime.now(timezone.utc)
    if a.inspect:
        if not links:
            sys.exit("Page loaded but no RacingFile.ashx sectional CSV links were found.")
        path, d = links[-1]
        fp = os.path.join(a.cache, path.split("/")[-1])
        if not os.path.exists(fp) and download:
            open(fp, "w", encoding="utf-8").write(get(RQ + "/RacingFile.ashx?path=" + path))
        text = open(fp, encoding="utf-8", errors="replace").read()
        print("file:", path)
        print("\n".join(text.splitlines()[:5]))
        rs = parse_csv(text)
        ok = [x for x in (analyse(r, a.code) for r in rs) if x]
        print(f"races parsed: {len(rs)}, analysable: {len(ok)}")
        if ok:
            h = sorted(ok[0]["runners"], key=lambda h: h["rank"])[0]
            print("winner:", h["name"], {k: round(h[k], 2) for k in ("perf_z", "close_z")}, "rank", h["rank"], "close_rank", h["close_rank"], "early_rank", h["early_rank"])
        return
    races = load(a.code, links, a.cache, download, a.days, end)
    print(f"usable races: {len(races)}", file=sys.stderr)
    if len(races) < 150:
        sys.exit("Not enough races to train (need 150+). Increase --days or check the cache.")
    cut = int(len(races) * 0.7)
    best = None
    for alpha in ALPHAS:
        pre, _ = run_pass(races, alpha)
        for beta in BETAS:
            tr = [softmax_ll(r["runners"], p, beta) for r, p in zip(races[:cut], pre[:cut]) if sum(v is not None for v in p) >= .6 * len(p)]
            if len(tr) >= 30:
                score = statistics.fmean(tr)
                if best is None or score < best[0]:
                    best = (score, alpha, beta)
    if best is None:
        sys.exit("Too few races where most runners have 2+ prior runs. Increase --days.")
    _, alpha, beta = best
    pre, hist = run_pass(races, alpha)
    ho_m, ho_u = [], []
    for r, p in zip(races[cut:], pre[cut:]):
        if sum(v is not None for v in p) >= .6 * len(p):
            ho_m.append(softmax_ll(r["runners"], p, beta))
            ho_u.append(math.log(len(p)))
    # masked-ability test: runners flagged last start, did they win this start more than 1/field?
    last, flagged, wins, exp = {}, 0, 0, 0.0
    for r in races:
        for h in r["runners"]:
            key = norm(h["name"])
            if key in last and last[key]:
                flagged += 1
                wins += h["rank"] == 1
                exp += 1 / h["n"]
            last[key] = h["masked"]
    ev = {"races": len(races), "holdout_races": len(ho_m), "logloss_model": round(statistics.fmean(ho_m), 4) if ho_m else None,
          "logloss_baseline": round(statistics.fmean(ho_u), 4) if ho_u else None, "masked_flagged": flagged, "masked_wins": wins,
          "masked_expected_wins": round(exp, 1)}
    use = len(ho_m) >= 40 and statistics.fmean(ho_m) < statistics.fmean(ho_u) - 0.01
    use_masked = flagged >= 40 and exp > 0 and wins / exp >= 1.15
    horses = {}
    cutoff = end.strftime("%Y%m%d")
    for key, runs in hist.items():
        if len(runs) < 2:
            continue
        lastrun = runs[-1]
        d = next(r["date"] for r in reversed(races) if lastrun in r["runners"])
        if (datetime.strptime(cutoff, "%Y%m%d") - datetime.strptime(d, "%Y%m%d")).days > a.keep_days:
            continue
        note = f"Closing speed {ordinal(lastrun['close_rank'])} of {lastrun['n']} last start but finished {ordinal(lastrun['rank'])}" if lastrun["masked"] else ""
        horses[key] = [round(rating(runs, alpha), 3), len(runs), int(d), lastrun["rank"], lastrun["n"], lastrun["close_rank"],
                       1 if lastrun["masked"] else 0, style_of(runs), note]
    model = {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "code": a.code, "alpha": alpha, "beta": beta,
             "useSectionals": use, "useMasked": use_masked, "eval": ev, "horses": horses}
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    json.dump(model, open(out, "w"), separators=(",", ":"))
    print(json.dumps({k: model[k] for k in ("updated", "code", "alpha", "beta", "useSectionals", "useMasked", "eval")}, indent=1))
    print(f"runners stored: {len(horses)}  -> {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
