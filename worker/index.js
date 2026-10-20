// Overlay Radar – single Cloudflare Worker:
//  • serves the static site from ./site (ASSETS binding)
//  • GET /api/feed   -> latest merged feed from KV
//  • GET /api/health -> last refresh times and errors per source
//  • cron            -> pulls free sources, merges, builds model inputs, stores in KV
import RATINGS from '../data/ratings.json';
import MODEL from '../data/horse_model.json';
import SECT_T from '../data/sectional_model.json';
import SECT_G from '../data/sectional_model_greyhound.json';
import { notify, sendAll } from './notify.js';

const BOOKS = ['Sportsbet','TAB','Ladbrokes','Neds','bet365','PointsBet','Betr','Unibet','Palmerbet','Dabble','Picklebet','Boombet','TopSport','BetRight','NextBet','TABtouch'];
const key = (b) => String(b).toLowerCase().replace(/[^a-z0-9]/g, '');
const CAN = Object.fromEntries(BOOKS.map((b) => [key(b), b]));
const canon = (b) => CAN[key(b)] || String(b);
// Normalisers shared with scripts/bsp_to_ratings.py (keep identical)
const nm = (s) => String(s || '').replace(/^\s*\d+\.\s*/, '').replace(/\(.*?\)/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const vk = (s) => String(s || '').replace(/\(.*?\)/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=15' } });

const sectSummary = (m) => ({ updated: m.updated, useSectionals: m.useSectionals, useMasked: m.useMasked, runnersRated: Object.keys(m.horses || {}).length, eval: m.eval });

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (p === '/api/feed') {
      const s = await env.STATE.get('state', 'json');
      return json(s && s.feed ? s.feed : { meetings: [], updated: null, sources: [] });
    }
    if (p === '/api/health') {
      const s = (await env.STATE.get('state', 'json')) || {};
      const ts = (k) => s[k] && s[k].ts;
      return json({ updated: s.feed && s.feed.updated, last: { puntersEdge: ts('pe'), tab: ts('tab'), hub: ts('hub'), extra: ts('extra'), betfairExchange: ts('bf') },
        errors: { puntersEdge: s.peErr, tab: s.tabErr, hub: s.hubErr, extra: s.extraErr, betfairExchange: s.bfErr }, model: { updated: MODEL.updated, b: MODEL.b, useResidual: MODEL.useResidual, eval: MODEL.eval },
        sectionals: { thoroughbred: sectSummary(SECT_T), greyhound: sectSummary(SECT_G) },
        feed: { sources: s.feed && s.feed.sources, meetings: s.feed ? s.feed.meetings.length : 0, races: s.feed ? s.feed.meetings.reduce((a, m) => a + m.races.length, 0) : 0 }, notify: { threshold: s.feed && s.feed.notify, ...s.notifyInfo } });
    }
    if (p === '/api/settings') {
      if (req.method === 'GET') return json((await env.STATE.get('settings', 'json')) || {});
      if (req.method === 'POST' && env.ADMIN_KEY && req.headers.get('authorization') === 'Bearer ' + env.ADMIN_KEY) {
        const v = +((await req.json().catch(() => ({}))).minOverlay);
        if (!(v >= 10 && v <= 1000)) return json({ error: 'minOverlay must be between 10 and 1000' }, 400);
        await env.STATE.put('settings', JSON.stringify({ minOverlay: v, updated: Date.now() }));
        return json({ ok: true, minOverlay: v });
      }
      return json({ error: 'unauthorised' }, 401);
    }
    if (p === '/api/notify-test' && env.ADMIN_KEY && req.headers.get('authorization') === 'Bearer ' + env.ADMIN_KEY) {
      return json(await sendAll(env, { title: '✅ Overlay Radar test', message: 'Notifications are working. You will only be messaged for overlays above your threshold.' }));
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil(run(env)); },
};

async function run(env) {
  const st = (await env.STATE.get('state', 'json')) || {};
  const now = Date.now(), jobs = [];
  const due = (k, mins) => now - Math.max((st[k] && st[k].ts) || 0, st[k + 'Try'] || 0) > mins * 6e4 - 15e3; // 15s tolerance for cron jitter; failed attempts also back off
  const job = (k, ek, fn) => { st[k + 'Try'] = now; jobs.push(fn().then((v) => { st[k] = { ts: now, ...v }; st[ek] = undefined; }).catch((e) => { st[ek] = String(e); })); };
  // Rate-limited sources refresh on their own intervals (free tiers are credit/write limited).
  if (env.PUNTERSEDGE_KEY && due('pe', +env.PE_INTERVAL_MIN || 60)) job('pe', 'peErr', () => puntersEdge(env).then((races) => ({ name: 'PuntersEdge', races })));
  if (env.TAB_CLIENT_ID && env.TAB_CLIENT_SECRET) job('tab', 'tabErr', () => tab(env).then((races) => ({ name: 'TAB', races })));
  if (env.EXTRA_FEEDS && due('extra', +env.EXTRA_INTERVAL_MIN || 5)) job('extra', 'extraErr', () => extra(env).then((races) => ({ name: 'Extra feeds', races })));
  if (env.BF_APP_KEY && env.BF_USER && env.BF_PASS && due('bf', +env.EXCHANGE_INTERVAL_MIN || 2)) job('bf', 'bfErr', () => exchange(env, st).then((races) => ({ name: 'Betfair Exchange', races })));
  if (env.HUB_RATINGS !== 'off' && due('hub', +env.HUB_INTERVAL_MIN || 30)) job('hub', 'hubErr', () => hub(env).then((map) => ({ name: 'Betfair Hub ratings', map })));
  await Promise.all(jobs);
  st.feed = build(st, now);
  const settings = await env.STATE.get('settings', 'json');
  try { await notify(settings && settings.minOverlay ? { ...env, NOTIFY_MIN_OVERLAY: String(settings.minOverlay) } : env, st, st.feed, now); } catch (e) { st.notifyInfo = { ...(st.notifyInfo || {}), errors: [String(e)] }; }
  await env.STATE.put('state', JSON.stringify(st)); // one KV write per run (free plan: 1,000/day)
}

/* ---------- Adapters ----------
   Race adapters return [{venue,country,no,start,runners:[{no,name,odds:{book:price}}]}]. */

// PuntersEdge next-to-go. Shape per PuntersEdge's own tutorial: GET /v1/racing/next-to-go?country=AU returns a list of
// {start_time, venue, race_number, category, runners:[{number, name, bookmakers:[{key, win_price, place_price}]}]}.
// Free tier is credit-limited (their pages say 1,500 or 3,000 a month), so it refreshes hourly by default.
// PE_COUNTRY (default AU; set NZ for New Zealand) and PE_CATEGORIES (default horse; add harness if wanted).
async function puntersEdge(env) {
  const country = env.PE_COUNTRY || 'AU', cats = String(env.PE_CATEGORIES || 'horse').split(',');
  const r = await fetch(`https://api.puntersedge.online/v1/racing/next-to-go?country=${country}&categories=${cats.join(',')}`, { headers: { 'X-API-Key': env.PUNTERSEDGE_KEY } });
  if (!r.ok) throw new Error('PuntersEdge ' + r.status);
  const j = await r.json();
  const list = Array.isArray(j) ? j : j.races || j.data || [];
  return list.filter((x) => !x.category || cats.includes(x.category)).map((x) => ({
    venue: x.venue, code: x.category || 'horse', country: x.country || (country === 'NZ' ? 'New Zealand' : 'Australia'), no: +x.race_number, start: x.start_time,
    runners: (x.runners || []).map((h) => ({ no: +h.number, name: h.name, odds: bookPrices(h.bookmakers) })).filter((h) => Object.keys(h.odds).length),
  })).filter((x) => x.venue && x.no && x.runners.length);
}
function bookPrices(list) {
  const out = {};
  for (const b of list || []) { const n = +b.win_price; if (n > 1) out[canon(b.key)] = n; }
  return out;
}
function prices(o) {
  const out = {};
  if (o) for (const [k, v] of Object.entries(o)) { const n = +((v && (v.price || v.win)) || v); if (n > 1) out[canon(k)] = n; }
  return out;
}

// ADAPT: endpoints/fields follow Tabcorp's public API as described by third-party docs; verify with your credentials.
// Free Workers plan allows 50 subrequests per run, so only the next MAX_TAB_RACES races are fetched.
async function tab(env) {
  const base = 'https://api.beta.tab.com.au';
  const tk = await fetch(base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.TAB_CLIENT_ID, client_secret: env.TAB_CLIENT_SECRET }) });
  if (!tk.ok) throw new Error('TAB auth ' + tk.status);
  const H = { authorization: 'Bearer ' + (await tk.json()).access_token };
  const d = new Date(Date.now() + 11 * 36e5).toISOString().slice(0, 10);
  const ml = await fetch(`${base}/v1/tab-info-service/racing/dates/${d}/meetings?jurisdiction=NSW&meetingType=R`, { headers: H });
  if (!ml.ok) throw new Error('TAB meetings ' + ml.status);
  const todo = [];
  for (const m of (await ml.json()).meetings || []) for (const r of m.races || []) if (new Date(r.raceStartTime) > Date.now()) todo.push({ m, r });
  todo.sort((a, b) => new Date(a.r.raceStartTime) - new Date(b.r.raceStartTime));
  const out = await Promise.all(todo.slice(0, +env.MAX_TAB_RACES || 15).map(async ({ m, r }) => {
    const res = await fetch(`${base}/v1/tab-info-service/racing/dates/${d}/meetings/R/${m.venueMnemonic}/races/${r.raceNumber}?fixedOdds=true&jurisdiction=NSW`, { headers: H });
    if (!res.ok) return null;
    const j = await res.json();
    return { venue: m.meetingName, country: 'Australia', no: r.raceNumber, start: r.raceStartTime,
      runners: (j.runners || []).filter((h) => h.fixedOdds && h.fixedOdds.returnWin > 1).map((h) => ({ no: h.runnerNumber, name: h.runnerName, odds: { TAB: h.fixedOdds.returnWin } })) };
  }));
  return out.filter(Boolean);
}

// Betfair Exchange (plug-in). Uses the free delayed App Key (prices are delayed) and Betfair's interactive login.
// Needs secrets BF_APP_KEY, BF_USER, BF_PASS. Back prices are shown net of commission (BF_COMMISSION, default 8%) as "Betfair Ex".
// Login endpoint is the documented AU/NZ one; the betting API base is tried at api-au.betfair.com then api.betfair.com
// (override with BF_API_BASE). Accounts with 2FA can't use this login. The session token is cached in KV to avoid repeat logins.
async function bfLogin(env) {
  const r = await fetch('https://identitysso.betfair.com.au/api/login', { method: 'POST', headers: { 'X-Application': env.BF_APP_KEY, Accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: env.BF_USER, password: env.BF_PASS }) });
  const j = await r.json().catch(() => ({}));
  if (j.status !== 'SUCCESS') throw new Error('Betfair login ' + (j.error || j.status || r.status));
  return j.token;
}
async function exchange(env, st) {
  const bases = [env.BF_API_BASE || 'https://api-au.betfair.com/exchange/betting/rest/v1.0', 'https://api.betfair.com/exchange/betting/rest/v1.0'];
  const call = async (method, body, retry = true) => {
    if (!st.bfToken || Date.now() - st.bfTokenTs > 3 * 36e5) { st.bfToken = await bfLogin(env); st.bfTokenTs = Date.now(); }
    let last;
    for (const base of bases) {
      const r = await fetch(`${base}/${method}/`, { method: 'POST', headers: { 'X-Application': env.BF_APP_KEY, 'X-Authentication': st.bfToken, 'content-type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (r.ok && j) return j;
      const code = j && j.detail && j.detail.APINGException && j.detail.APINGException.errorCode;
      if (code === 'INVALID_SESSION_INFORMATION' && retry) { st.bfToken = null; return call(method, body, false); }
      last = new Error(`Betfair ${method} ${r.status} ${code || ''}`);
    }
    throw last;
  };
  const from = new Date().toISOString(), to = new Date(Date.now() + 3 * 36e5).toISOString();
  const cat = await call('listMarketCatalogue', { filter: { eventTypeIds: ['7'], marketCountries: ['AU', 'NZ'], marketTypeCodes: ['WIN'], marketStartTime: { from, to } }, marketProjection: ['EVENT', 'MARKET_START_TIME', 'RUNNER_DESCRIPTION'], sort: 'FIRST_TO_START', maxResults: +env.MAX_EXCHANGE_MARKETS || 40 });
  const comm = env.BF_COMMISSION !== undefined ? +env.BF_COMMISSION : 0.08, out = [];
  for (let i = 0; i < cat.length; i += 20) {
    const ch = cat.slice(i, i + 20);
    const books = await call('listMarketBook', { marketIds: ch.map((m) => m.marketId), priceProjection: { priceData: ['EX_BEST_OFFERS'], exBestOfferOverRides: { bestPricesDepth: 1 } } });
    for (const m of ch) {
      const b = books.find((x) => x.marketId === m.marketId), rn = /^R\s*(\d+)/i.exec(m.marketName || '');
      if (!b || !rn || !m.event) continue;
      const price = new Map((b.runners || []).filter((r) => r.status === 'ACTIVE' && r.ex && r.ex.availableToBack && r.ex.availableToBack[0]).map((r) => [r.selectionId, r.ex.availableToBack[0].price]));
      const runners = [];
      for (const r of m.runners || []) {
        const num = /^\s*(\d+)\./.exec(r.runnerName || ''), p = price.get(r.selectionId);
        if (num && p > 1) runners.push({ no: +num[1], name: r.runnerName, odds: { 'Betfair Ex': +(1 + (p - 1) * (1 - comm)).toFixed(2) } });
      }
      if (runners.length) out.push({ venue: m.event.venue || String(m.event.name || '').replace(/\s*\(.*$/, ''), country: m.event.countryCode === 'NZ' ? 'New Zealand' : 'Australia', no: +rn[1], start: m.marketStartTime, runners });
    }
  }
  return out;
}

// Plug-in point for ANY other source: set EXTRA_FEEDS to comma-separated JSON URLs (e.g. your own aggregator).
// Each must return {"races":[{"venue","country","no","start","runners":[{"no","name","odds":{"Sportsbet":3.1,...}}]}]}.
// Optional EXTRA_FEEDS_AUTH is sent as the Authorization header.
async function extra(env) {
  const out = [];
  for (const u of String(env.EXTRA_FEEDS).split(',').map((s) => s.trim()).filter(Boolean)) {
    const r = await fetch(u, { headers: env.EXTRA_FEEDS_AUTH ? { authorization: env.EXTRA_FEEDS_AUTH } : {} });
    if (!r.ok) throw new Error(u + ' ' + r.status);
    for (const x of (await r.json()).races || []) out.push({ venue: x.venue, code: x.code || 'horse', country: x.country, no: +x.no, start: x.start, runners: (x.runners || []).map((h) => ({ no: +h.no, name: h.name, odds: prices(h.odds), tips: +h.tips || 0, style: h.style })) });
  }
  return out;
}

// Betfair Hub thoroughbred ratings (rated prices). Public download link pattern from Betfair's own tutorial (2022);
// override with HUB_URL (use {date} placeholder) or disable with HUB_RATINGS=off. Errors show in /api/health.
async function hub(env) {
  const d = new Date(Date.now() + 11 * 36e5).toISOString().slice(0, 10);
  const url = (env.HUB_URL || 'https://betfair-data-supplier-prod.herokuapp.com/api/widgets/kash-ratings-model/datasets?date={date}&presenter=RatingsPresenter&csv=true').replace('{date}', d);
  const r = await fetch(url);
  if (!r.ok) throw new Error('Hub ratings ' + r.status);
  const rows = parseCSV(await r.text());
  if (rows.length < 2) throw new Error('Hub ratings empty');
  const H = rows[0].map((x) => x.trim().toLowerCase()), find = (re) => H.findIndex((h) => re.test(h));
  const iV = find(/meetings\.name$/), iR = find(/races\.(number|racenumber)$/), iN = find(/runners\.(number|runnernumber|tabno|saddlecloth)$/), iM = find(/runners\.(runnername|name)$/), iP = find(/ratedprice$/);
  if (iV < 0 || iR < 0 || iP < 0 || (iN < 0 && iM < 0)) throw new Error('Hub CSV columns not recognised: ' + H.join('|'));
  const map = {};
  for (const c of rows.slice(1)) {
    const p = +c[iP];
    if (!(p > 1)) continue;
    const k = vk(c[iV]) + '|' + +c[iR] + '|';
    if (iN >= 0 && c[iN]) map[k + +c[iN]] = p;
    if (iM >= 0 && c[iM]) map[k + 'n:' + nm(c[iM])] = p;
  }
  return map;
}
function parseCSV(t) {
  const rows = []; let r = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; r.push(f); f = ''; if (r.length > 1 || r[0] !== '') rows.push(r); r = []; }
    else f += c;
  }
  if (f !== '' || r.length) { r.push(f); rows.push(r); }
  return rows;
}

/* ---------- Model inputs ---------- */
const B = +MODEL.b || 1;
const power = (ps, b) => { const q = ps.map((p) => Math.pow(Math.max(p, 1e-6) / 100, b)), s = q.reduce((a, x) => a + x, 0); return q.map((x) => (100 * x) / s); };

// De-vigged average win probability (%) across every book that prices the whole field. Needs 3+ books.
function consensus(runners) {
  const books = new Set();
  runners.forEach((h) => Object.keys(h.odds).forEach((b) => books.add(b)));
  const per = [];
  for (const b of books) {
    if (!runners.every((h) => h.odds[b] > 1)) continue;
    const ip = runners.map((h) => 1 / h.odds[b]), sum = ip.reduce((a, x) => a + x, 0);
    per.push(ip.map((x) => x / sum));
  }
  return per.length < 3 ? null : runners.map((_, i) => (100 * per.reduce((a, p) => a + p[i], 0)) / per.length);
}

// BSP-trained form model: calibrated market probability plus each horse's learned residual vs the market.
// Only used when the training script found the residual helped out-of-sample (MODEL.useResidual).
function formModel(runners, cons) {
  if (!MODEL.useResidual || !cons) return null;
  let known = 0;
  const u = runners.map((h, i) => {
    const e = MODEL.horses[nm(h.name)], ok = e && e[1] >= 3;
    if (ok) known++;
    return B * Math.log(Math.max(cons[i], 1e-6) / 100) + (ok ? e[0] : 0);
  });
  if (known < 2) return null;
  const mx = Math.max(...u), q = u.map((x) => Math.exp(x - mx)), s = q.reduce((a, x) => a + x, 0);
  return q.map((x) => (100 * x) / s);
}

// Sectionals model (scripts/sectionals_model.py): per-runner rating from closing speed + overall time vs the field.
// Needs 2+ rated runners in 60% of the field; unrated runners get the field-average rating. Gated by useSectionals.
function sectionalProbs(runners, M) {
  const info = runners.map((h) => { const e = M.horses[nm(h.name)]; return e && e[1] >= 2 ? { r: e[0], style: e[7], note: e[6] ? e[8] : null } : null; });
  const known = info.filter(Boolean);
  if (!M.useSectionals || known.length < Math.ceil(0.6 * runners.length)) return { probs: null, info };
  const mean = known.reduce((a, x) => a + x.r, 0) / known.length, u = info.map((x) => (M.beta || 0) * (x ? x.r : mean)), mx = Math.max(...u), q = u.map((v) => Math.exp(v - mx)), s = q.reduce((a, x) => a + x, 0);
  return { probs: q.map((v) => (100 * v) / s), info };
}

function build(st, now) {
  const srcs = [st.pe, st.tab, st.bf, st.extra].filter((s) => s && s.races);
  const hubMap = (st.hub && st.hub.map) || {};
  let hubUsed = false;
  const races = new Map();
  for (const s of srcs) for (const r of s.races) {
    const code = r.code || 'horse', k = vk(r.venue) + '|' + code + '|' + r.no;
    let m = races.get(k);
    if (!m) races.set(k, (m = { venue: r.venue, code, country: r.country || 'Australia', no: r.no, start: r.start, runners: new Map() }));
    for (const h of r.runners) {
      let x = m.runners.get(h.no);
      if (!x) m.runners.set(h.no, (x = { no: h.no, name: h.name, odds: {}, tips: 0, style: null }));
      Object.assign(x.odds, h.odds);
      x.tips = Math.max(x.tips, h.tips || 0); x.style = x.style || h.style || null;
    }
  }
  const meetings = new Map();
  for (const m of races.values()) {
    if (m.start && new Date(m.start) < now - 3e5) continue;
    const runners = [...m.runners.values()].sort((a, b) => a.no - b.no);
    const cons = consensus(runners), calib = cons ? power(cons, B) : null, form = formModel(runners, cons);
    const SM = m.code === 'greyhound' ? SECT_G : SECT_T, sect = sectionalProbs(runners, SM);
    const rows = runners.map((h, i) => {
      // Optional own ratings: data/ratings.json key "venue|race|runner" (venue lowercase, letters+digits only)
      const x = RATINGS[vk(m.venue) + '|' + m.no + '|' + h.no] || {};
      const hv = m.code === 'greyhound' ? undefined : hubMap[vk(m.venue) + '|' + m.no + '|' + h.no] ?? hubMap[vk(m.venue) + '|' + m.no + '|n:' + nm(h.name)];
      if (hv > 1) hubUsed = true;
      const si = sect.info[i];
      return { no: h.no, name: h.name, odds: h.odds, style: x.style || h.style || (si && si.style) || 'M', tips: x.tips || h.tips || 0, hint: si && SM.useMasked && si.note ? si.note : undefined,
        probs: [x.ratings ?? (hv > 1 ? 100 / hv : null), x.form ?? (form ? form[i] : null), x.tipsters ?? null, calib ? calib[i] : null, x.speed ?? (sect.probs ? sect.probs[i] : null)] };
    });
    const mk = m.venue + '|' + m.code;
    if (!meetings.has(mk)) meetings.set(mk, { name: m.venue, code: m.code, country: m.country, region: /^(australia|new zealand)$/i.test(m.country) ? 'anz' : 'int', sky: false, races: [] });
    meetings.get(mk).races.push({ n: m.no, start: m.start, runners: rows });
  }
  const list = [...meetings.values()];
  list.forEach((m) => m.races.sort((a, b) => a.n - b.n));
  const names = srcs.map((s) => s.name);
  if (hubUsed) names.push('Betfair Hub ratings');
  if (MODEL.useResidual) names.push('BSP form model');
  if (SECT_T.useSectionals || SECT_G.useSectionals) names.push('RQ sectionals model');
  return { updated: new Date(now).toISOString(), sources: names, meetings: list };
}
