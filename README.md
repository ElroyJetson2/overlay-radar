# Overlay Radar

Horse racing overlay analyser. One Cloudflare Worker serves the site, exposes `/api/feed`, and refreshes data on a cron. GitHub Actions deploys on push and retrains the BSP model nightly.

```
site/index.html            the app (sample data until a live source returns races)
worker/index.js            static hosting, /api/feed, /api/health, cron refresh, adapters, model inputs
scripts/bsp_to_ratings.py  turns Betfair's free BSP CSVs into data/horse_model.json
data/ratings.json          optional: your own ratings / tips / run styles
data/horse_model.json      generated: BSP calibration exponent + horse residuals
wrangler.toml              Cloudflare config (assets, KV, cron, intervals)
.github/workflows/         deploy.yml (auto-deploy), update-model.yml (nightly BSP training)
```

## Set up (about 10 minutes)

1. **GitHub:** create a repo and push this folder to `main`.
2. **KV:** the `STATE` namespace id in `wrangler.toml` is already set to the one in your Cloudflare account. On a fresh account run `npx wrangler kv namespace create STATE` and paste the new `id`.
3. **GitHub secrets:** `CLOUDFLARE_API_TOKEN` (Edit Cloudflare Workers template) and `CLOUDFLARE_ACCOUNT_ID`.
4. **Push to `main`.** Live at `https://overlay-radar.<subdomain>.workers.dev`; add a custom domain in the Cloudflare dashboard.
5. **Optional source keys** (Worker secrets, never committed):
   ```
   npx wrangler secret put PUNTERSEDGE_KEY
   npx wrangler secret put TAB_CLIENT_ID
   npx wrangler secret put TAB_CLIENT_SECRET
   npx wrangler secret put EXTRA_FEEDS          # comma-separated JSON URLs, see below
   npx wrangler secret put BF_APP_KEY           # Betfair Exchange (all three needed)
   npx wrangler secret put BF_USER
   npx wrangler secret put BF_PASS
   ```
6. Open `/api/health` for last refresh times, per-source errors and the model's out-of-sample evaluation.

## Adapters

| Source | Gives | Key needed | Status |
|---|---|---|---|
| **Betfair Hub ratings** (CSV) | Betfair's own thoroughbred rated prices → source slot 1 | none | URL pattern taken from Betfair's 2022 tutorial; **unverified today**. Errors (including unrecognised CSV columns) appear in `/api/health`. Override with `HUB_URL`, disable with `HUB_RATINGS=off`. |
| **PuntersEdge** | Per-bookmaker win prices for the next races (horse only by default) | free key | Response shape taken from PuntersEdge's own tutorial (`/v1/racing/next-to-go?country=AU`, bookmakers list per runner). Not yet run against a real key. Default refresh 60 min; their pages quote 1,500 or 3,000 free credits a month. `PE_COUNTRY=NZ`, `PE_CATEGORIES=horse,harness` to change. Free tier is personal-use only. |
| **TAB API** | TAB fixed odds, next 15 races | client credentials | Endpoints follow third-party docs (`ADAPT`). |
| **Betfair Exchange** | Best back price per runner, net of commission (shown as "Betfair Ex"), next 3h, up to 40 races | free delayed App Key + your login | Login endpoint is the documented AU/NZ one; betting base `api-au.betfair.com` (falls back to `api.betfair.com`, override `BF_API_BASE`) is **unverified**. Prices are delayed. 2FA accounts can't use this login. Session cached in KV. Tested against mocked responses only. Commission via `BF_COMMISSION` (default 0.08). |
| **EXTRA_FEEDS** | Anything else, including **tips** (the only way to make races glow green in live mode) | optional | Plug-in: URLs returning `{"races":[{"venue","country","no","start","runners":[{"no","name","odds":{"Sportsbet":3.1},"tips":2,"style":"L"}]}]}`. Host your own aggregator/collector anywhere and point to it. |
| **BSP model** | Calibrated market + horse form residual → source slot 2 and calibrated consensus → slot 4 | none | Runs nightly in GitHub Actions. |

Not included: scrapers for bookmaker or tipping sites (usually breach terms and get blocked).

## Running the BSP script on real data

```
python scripts/bsp_to_ratings.py --inspect          # 1. confirm the real file layout parses
python scripts/bsp_to_ratings.py --days 240         # 2. train (first run downloads ~240 small files)
```
1. `--inspect` downloads the newest available day, prints the header and first rows, and shows how runner names normalise. Check that `parsed races` is above zero and names look right (a leading `1.` is stripped automatically). If the layout differs from the documented columns, send me the printed output and I'll adjust the parser.
2. After training, read `data/horse_model.json`: `b` (calibration exponent), `eval.logloss_market` vs `logloss_calibrated` vs `logloss_model` (lower is better), and `useResidual`. Commit it; the nightly Action keeps it fresh.

## The BSP script

```
python scripts/bsp_to_ratings.py --days 240
```
Downloads `dwbfpricesauswin<DDMMYYYY>.csv` from promo.betfair.com (cached in `.cache/bsp`), then:

1. Fits a calibration exponent `b`: market probability `p` becomes `p^b` renormalised (fixes favourite/longshot bias).
2. Learns a per-horse residual against the market with a softmax Elo update.
3. Scores everything prequentially on the last 20% of races (market vs calibrated vs calibrated+residual) and writes the result to `data/horse_model.json` under `eval`.

The Worker uses the residual only if `useResidual` is true, meaning it beat the calibrated market out of sample. BSP is an efficient price, so that is a high bar; calibration alone still improves the consensus. The script was tested on synthetic Betfair-format files only. Run it once locally and read `eval` before trusting it.

## Tips and alerts

**Green glow = a tip.** A race glows green when either 2+ tipsters name the same runner (via `ratings.json` or `EXTRA_FEEDS`), or when the engine makes its own **model tip**: the runner with the best win chance among those with win chance 20%+, a best price 8%+ over fair, at least 80% of available sources agreeing, and a race shape that doesn't work against its run style. Agreement is counted among **independent ratings only** (Hub or your ratings, form model, tipsters, speed), never the market itself. A race with market prices only can raise an amber **price-outlier** alert but cannot produce a green model tip, because a tip needs an independent view. The race panel shows both numbers: what the indicators say the horse should pay, and the blended fair price (which also weighs the market, 25%). Amber = a value alert (30%+ overlay). The race panel says which kind and why. Browser alerts need the 🔔 button (browsers block prompts without a click).

## How alerts work

1. Each available source is normalised per race and blended: Hub or own ratings 25%, form model 20%, tipsters 15%, calibrated market consensus 25%, pace-adjusted speed 15%.
2. A runner is flagged when best price is 30%+ above fair and at least 80% of the available sources agree.
3. With only market consensus, an alert means one book is far above the rest of the market. More sources make alerts more meaningful.

## Free-tier limits

- **KV:** 1,000 writes/day; the default cron (every 2 min, racing hours) uses about 420.
- **Subrequests:** 50 per run on the free plan, so TAB is capped at `MAX_TAB_RACES` (15).
- **PuntersEdge free tier:** about 1,500 credits a month; its own docs say it cannot run a live scanner, so prices can be an hour old. Treat any alert as "check the book now".

Gamble responsibly. Gambling Help Online: 1800 858 858.
