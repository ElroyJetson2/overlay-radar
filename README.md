# Overlay Radar

Horse racing overlay analyser. One Cloudflare Worker serves the site, exposes `/api/feed`, and refreshes data on a cron. GitHub Actions deploys on every push to `main`.

```
site/index.html      the app (works standalone on sample data)
worker/index.js      static hosting + /api/feed + /api/health + cron refresh + adapters
data/ratings.json    optional: your own model ratings / tips / run styles
wrangler.toml        Cloudflare config (assets, KV, cron)
.github/workflows/   auto-deploy
```

## Set up (about 10 minutes)

1. **GitHub:** create a repo and push this folder to `main`.
2. **Cloudflare KV:** `npm install`, then `npx wrangler login` and `npx wrangler kv namespace create STATE`. Paste the returned `id` into `wrangler.toml`.
3. **GitHub secrets** (repo → Settings → Secrets → Actions):
   - `CLOUDFLARE_API_TOKEN` – create at dash.cloudflare.com → My Profile → API Tokens → *Edit Cloudflare Workers* template
   - `CLOUDFLARE_ACCOUNT_ID` – shown on the Workers & Pages overview page
4. **Push to `main`.** The Action deploys to `https://overlay-radar.<your-subdomain>.workers.dev`. Add a custom domain under Workers & Pages → overlay-radar → Settings → Domains.
5. **Data source keys** (optional, set as Worker secrets; never commit them):
   ```
   npx wrangler secret put PUNTERSEDGE_KEY
   npx wrangler secret put TAB_CLIENT_ID
   npx wrangler secret put TAB_CLIENT_SECRET
   ```
6. Check `/api/health` for last refresh times and errors. The page badge shows `SAMPLE DATA` until a live source returns races, then `● LIVE`.

Local test: `npm run dev`, open the printed URL, and trigger the cron with `curl "http://localhost:8787/cdn-cgi/handler/scheduled"`.

## How the data flows

1. **Adapters** (`puntersEdge`, `tab`) return races with per-bookmaker decimal odds.
2. **Merge** joins sources by venue + race + runner number, so more books appear as more sources are added.
3. **Consensus**: for every book pricing the whole field, odds are de-vigged and averaged into a market win probability (needs 3+ books). That fills source slot 4.
4. **Your model** (`data/ratings.json`): fill slots for ratings, sectionals, tipsters and pace-neutral speed. Provide every runner in a race or the slot is ignored for that race.
5. **The page** normalises each available source, blends them by weight, and flags a runner when best price is 30%+ over fair and at least 80% of the available sources agree.

With only market consensus, an alert means one book is well above the rest of the market. Add your own ratings for genuine model-based overlays.

## Free-tier limits to know

- **KV:** 1,000 writes/day. The default cron (every 2 min, racing hours) uses about 420.
- **Subrequests:** 50 per run on the free plan, so TAB is capped at `MAX_TAB_RACES` (15) per run.
- **PuntersEdge free tier:** about 1,500 credits/month. The default 35-minute interval keeps within that, so those prices can be up to 35 minutes old. Overlays can vanish faster than that. Treat any alert as "check the book now".
- The adapters are **untested best-effort**: confirm response field names and auth against each provider's current docs and terms, then adjust the `ADAPT` sections.

## Not included, on purpose

No scraping of bookmaker, tipping or form sites. It usually breaches their terms and gets blocked. Add further sources as new adapters that return the same shape.

Gamble responsibly. Gambling Help Online: 1800 858 858.
