# Overlay Radar

Horse racing overlay analyser. One Cloudflare Worker serves the site, exposes `/api/feed`, and refreshes data on a cron. GitHub Actions deploys on push and retrains the BSP model nightly.

```
site/index.html            the app (sample data until a live source returns races)
worker/index.js            static hosting, /api/feed, /api/health, cron refresh, adapters, model inputs
scripts/bsp_to_ratings.py  turns Betfair's free BSP CSVs into data/horse_model.json
data/ratings.json          optional: your own ratings / tips / run styles
data/horse_model.json      generated: BSP calibration exponent + horse residuals
data/sectional_model*.json generated: Racing Queensland sectionals ratings (horses, greyhounds)
scripts/sectionals_model.py Racing Queensland sectionals -> ratings, hidden-ability flags, run styles
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

## Sectionals: horses and greyhounds (Racing Queensland, free)

Racing Queensland publishes a free sectionals CSV for nearly every Queensland meeting (thoroughbred and harness verified; greyhound announced for Brisbane and Ipswich, about 60% of Queensland races). The nightly job downloads them and builds, per horse or dog:

- **A rating** from closing speed and overall time against the field, turned into win chances across today's field (so a weak field helps a good runner automatically). It feeds the "speed" slot, which counts as an **independent** rating.
- **Hidden-ability flag**: top-20% closing speed but finished in the bottom half. Shown in the race panel as "Form may hide its ability: closing speed 1st of 8 last start but finished 6th".
- **Run style** (leader, on pace, midfield, off pace, backmarker) from early speed, which drives the pace map with real data.

Everything is gated by an out-of-sample test. `data/sectional_model*.json` records `useSectionals` (did the rating beat a no-information baseline on later races?) and `useMasked` (did flagged runners really win next start more than chance?). If a gate is false, that part is not used.

```
python scripts/sectionals_model.py --inspect                  # check the real file layout parses
python scripts/sectionals_model.py --code thoroughbred --days 150
python scripts/sectionals_model.py --code greyhound --days 150   # page URL is unverified; override with --page-url
```
The parser was verified on real Racing Queensland rows and trained end to end on synthetic files in the same format. It has **not** been run on a full real download, and the greyhound page URL and file layout are unconfirmed (use `--inspect`). Coverage is Queensland only: a runner needs 2+ prior Queensland runs to be rated, and unrated runners get the field-average rating.

To use greyhounds in the live feed, set `PE_CATEGORIES=horse,greyhound` (PuntersEdge uses more credits per refresh). Betfair Hub ratings and the Exchange adapter are horse-only.

### State by state (what I could verify)

| State | Thoroughbred | Harness | Greyhound | Status |
|---|---|---|---|---|
| **QLD** | Free CSV per meeting (Racing Queensland) | Free CSV (Redcliffe, Marburg) | Free for Brisbane and Ipswich (about 60% of races) | **Built** (horses, greyhounds; harness parses with `--code harness`) |
| **NSW** | Racing NSW "Punter's Intelligence" product; no open feed verified | Harness Racing NSW publishes sectional PDFs | Nothing verified | Not built |
| **VIC** | Racing Victoria sectionals via racing.com / Daily Sectionals; no open download verified | HRV Sectionals Hub lets you download any Victorian meeting since 1 Jan 2023 | GRV Race Data (Isolynx) CSV/JSON on Google Drive, being phased out into the Watchdog app | Not built (harness and GRV are the most promising; format and terms to confirm) |
| **WA** | Racing WA publishes meeting downloads; no sectional feed confirmed | Nothing verified | Nothing verified | Not built |
| **SA** | Nothing verified | Nothing verified | Nothing verified | Not built |
| **TAS** | Sectionals by Daily Sectionals shown on Tasracing's form site (free account); reuse unconfirmed | Nothing verified | Nothing verified | Not built |
| **NT / ACT** | Nothing verified | Nothing verified | Nothing verified | Not built |

I have not built scrapers for sites whose terms restrict automated collection (Racing Australia, racing.com, Racing and Sports and others). If you obtain permission or a licence for any of them, or one of the open sources above proves usable, `sectionals_model.py` already works for any page that links CSVs in the Racing Queensland layout (`--page-url`); other layouts need a small parser added.

## Push notifications (big overlays only)

The Worker checks for opportunities on every refresh and messages your phone when a runner's overlay is at or above your threshold (default **80%**, meaning the best price is at least 1.8x the fair price). It works while your phone and browser are closed. Everything below that, you look at in the app.

**Set up ntfy (free, 5 minutes):**
1. Install the **ntfy** app (iOS or Android) and subscribe to a topic with a long random name, e.g. `overlay-k7q2x9m4p1z8`. Anyone who knows a ntfy.sh topic name can read it, so treat the name like a password.
2. `npx wrangler secret put NTFY_TOPIC` and enter that topic.
3. Optional: `npx wrangler secret put ADMIN_KEY` (any long random string), then test delivery:
   `curl -H "Authorization: Bearer <ADMIN_KEY>" https://overlay-radar.<subdomain>.workers.dev/api/notify-test`
4. Optional: set `SITE_URL` (a Worker variable) so tapping a notification opens the app.

**Other channels (any combination):** Telegram (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`) or Discord (`DISCORD_WEBHOOK`), all as Worker secrets.

**Change the threshold from the app:** use the **Push alerts ≥** dropdown in the top bar (30% to 200%). The first time, it asks for your `ADMIN_KEY` (stored in this browser only) and saves the value on the server (`POST /api/settings`), where it overrides `NOTIFY_MIN_OVERLAY`. The **Show overlays ≥** dropdown only changes what the app highlights.

**Settings** (Worker variables in `wrangler.toml`): `NOTIFY_MIN_OVERLAY` (percent, default 80, used until you save a value from the app), `NOTIFY_WINDOW_MIN` (only races jumping within this many minutes, default 90), `NOTIFY_OUTLIERS=true` (also alert on price outliers with no independent rating behind them; off by default because a lone huge price is often a stale or erroneous one).

**Behaviour:** a message is sent once per runner, and again only if the overlay grows by 25+ points. Races that are about to jump (under 2 minutes) or have jumped are skipped. At most 5 messages per refresh, biggest first. If every channel fails, it retries on the next refresh. `/api/health` shows the threshold, last send time and any delivery errors.

**Limits:** it only runs during the cron window (00:00-13:59 UTC, covering Australian racing) and can only be as fresh as your sources: PuntersEdge prices refresh hourly by default, and the Betfair delayed key delays Exchange prices, so treat every message as "go and check the book now". The page's own 🔔 button only works while the tab is open and also uses the 80% threshold.

## Who to take on: the four looks

The app's **Who to take on** section lists current picks, best first, and the race grid uses the same colours:

| Look | Rule | Meaning |
|---|---|---|
| 💎 **Violet glow**: Best bet | A tip (2+ tipsters, or our model's pick) **or** a 50%+ chance, **and** over the odds (overlay above the "Show overlays" threshold with independent ratings agreeing) | The runner the evidence likes, paying more than it should. Shows the best price and bookmaker and a suggested stake (quarter Kelly, capped at 5% of bank). |
| 🔥 **Red glow**: Strong chance | Blended win chance above 50% | Very likely winner; the price is about right, so it is a confidence pick rather than a value bet. |
| **Green glow**: Tip | 2+ tipsters, or our model's pick | Tipped, but the price is not far enough over fair to be a best bet. |
| **Amber chip**: Over the odds | Overlay above the threshold | A price the evidence says is too big, with no tip or 50%+ chance behind it. |

If a race has several, the strongest look wins (violet, then red, then green). Win chance is the blended view (independent ratings plus the market at 25%), not a guarantee; treat 50%+ as "very likely", not "certain".

## Tips and alerts

**Green glow = a tip.** A race glows green when either 2+ tipsters name the same runner (via `ratings.json` or `EXTRA_FEEDS`), or when the engine makes its own **model tip**: the runner with the best win chance among those with win chance 20%+, a best price 8%+ over fair, at least 80% of available sources agreeing, and a race shape that doesn't work against its run style. Agreement is counted among **independent ratings only** (Hub or your ratings, tipsters, speed or sectionals). The market and the BSP form model do not count, because the form model is built from the market price. A race with market prices only can raise an amber **price-outlier** alert but cannot produce a green model tip, because a tip needs an independent view. The race panel shows both numbers: what the indicators say the horse should pay, and the blended fair price (which also weighs the market, 25%). Amber = a value alert (30%+ overlay). The race panel says which kind and why. Browser alerts need the 🔔 button (browsers block prompts without a click).

## How alerts work

1. Each available source is normalised per race and blended: Hub or own ratings 25%, form model 20%, tipsters 15%, calibrated market consensus 25%, pace-adjusted speed 15%.
2. A runner is flagged when best price is 30%+ above fair and at least 80% of the available sources agree.
3. With only market consensus, an alert means one book is far above the rest of the market. More sources make alerts more meaningful.

## Free-tier limits

- **KV:** 1,000 writes/day; the default cron (every 2 min, racing hours) uses about 420.
- **Subrequests:** 50 per run on the free plan, so TAB is capped at `MAX_TAB_RACES` (15).
- **PuntersEdge free tier:** about 1,500 credits a month; its own docs say it cannot run a live scanner, so prices can be an hour old. Treat any alert as "check the book now".

Gamble responsibly. Gambling Help Online: 1800 858 858.
