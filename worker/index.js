// Overlay Radar – single Cloudflare Worker:
//  • serves the static site from ./site (ASSETS binding)
//  • GET /api/feed   -> latest merged feed from KV
//  • GET /api/health -> last refresh times and errors
//  • cron            -> pulls free sources, merges, computes market consensus, stores in KV
import RATINGS from '../data/ratings.json';

const BOOKS = ['Sportsbet','TAB','Ladbrokes','Neds','bet365','PointsBet','Betr','Unibet','Palmerbet','Dabble','Picklebet','Boombet','TopSport','BetRight'];
const key = (b) => String(b).toLowerCase().replace(/[^a-z0-9]/g, '');
const CAN = Object.fromEntries(BOOKS.map((b) => [key(b), b]));
const canon = (b) => CAN[key(b)] || String(b);
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=15' } });

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (p === '/api/feed') {
      const s = await env.STATE.get('state', 'json');
      return json(s && s.feed ? s.feed : { meetings: [], updated: null, sources: [] });
    }
    if (p === '/api/health') {
      const s = (await env.STATE.get('state', 'json')) || {};
      return json({ updated: s.feed && s.feed.updated, puntersEdge: s.pe && s.pe.ts, tab: s.tab && s.tab.ts, peErr: s.peErr, tabErr: s.tabErr });
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil(run(env)); },
};

async function run(env) {
  const st = (await env.STATE.get('state', 'json')) || {};
  const now = Date.now();
  const jobs = [];
  // PuntersEdge free tier is credit-limited, so it refreshes on its own slower interval.
  if (env.PUNTERSEDGE_KEY && (!st.pe || now - st.pe.ts > (+env.PE_INTERVAL_MIN || 35) * 6e4)) {
    jobs.push(puntersEdge(env).then((races) => { st.pe = { name: 'PuntersEdge', ts: now, races }; st.peErr = undefined; }).catch((e) => { st.peErr = String(e); }));
  }
  if (env.TAB_CLIENT_ID && env.TAB_CLIENT_SECRET) {
    jobs.push(tab(env).then((races) => { st.tab = { name: 'TAB', ts: now, races }; st.tabErr = undefined; }).catch((e) => { st.tabErr = String(e); }));
  }
  await Promise.all(jobs);
  st.feed = build([st.pe, st.tab].filter(Boolean), now);
  await env.STATE.put('state', JSON.stringify(st)); // one KV write per run (free plan: 1,000/day)
}

/* ---------- Adapters: each returns [{venue,country,no,start,runners:[{no,name,odds:{book:price}}]}] ---------- */

// ADAPT: field names below are best-effort; confirm against the PuntersEdge docs and adjust.
async function puntersEdge(env) {
  const r = await fetch('https://api.puntersedge.online/v1/racing/next-to-go?categories=horse', { headers: { 'X-API-Key': env.PUNTERSEDGE_KEY } });
  if (!r.ok) throw new Error('PuntersEdge ' + r.status);
  const j = await r.json();
  const list = Array.isArray(j) ? j : j.races || j.data || [];
  return list.map((x) => ({
    venue: x.venue || x.meeting || x.track, country: x.country, no: +(x.race_number || x.number || x.race),
    start: x.start_time || x.start || x.jump_time,
    runners: (x.runners || []).map((h) => ({ no: +(h.number || h.runner_number || h.no), name: h.name || h.runner, odds: prices(h.prices || h.odds || h.win_odds) })),
  })).filter((x) => x.venue && x.no && x.runners.length);
}
function prices(o) {
  const out = {};
  if (o) for (const [k, v] of Object.entries(o)) { const n = +((v && (v.price || v.win)) || v); if (n > 1) out[canon(k)] = n; }
  return out;
}

// ADAPT: endpoints/fields follow Tabcorp's public API as described by third-party docs; verify with your TAB credentials.
// Free Workers plan allows 50 subrequests per run, so only the next MAX_TAB_RACES races are fetched.
async function tab(env) {
  const base = 'https://api.beta.tab.com.au';
  const tk = await fetch(base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.TAB_CLIENT_ID, client_secret: env.TAB_CLIENT_SECRET }) });
  if (!tk.ok) throw new Error('TAB auth ' + tk.status);
  const H = { authorization: 'Bearer ' + (await tk.json()).access_token };
  const d = new Date(Date.now() + 11 * 36e5).toISOString().slice(0, 10); // AEDT date
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

/* ---------- Merge + model inputs ---------- */

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

function build(srcs, now) {
  const races = new Map();
  for (const s of srcs) for (const r of s.races) {
    const k = r.venue.toLowerCase() + '|' + r.no;
    let m = races.get(k);
    if (!m) races.set(k, (m = { venue: r.venue, country: r.country || 'Australia', no: r.no, start: r.start, runners: new Map() }));
    for (const h of r.runners) {
      let x = m.runners.get(h.no);
      if (!x) m.runners.set(h.no, (x = { no: h.no, name: h.name, odds: {} }));
      Object.assign(x.odds, h.odds);
    }
  }
  const meetings = new Map();
  for (const m of races.values()) {
    if (m.start && new Date(m.start) < now - 3e5) continue;
    const runners = [...m.runners.values()].sort((a, b) => a.no - b.no);
    const cons = consensus(runners);
    const rows = runners.map((h, i) => {
      // Optional own ratings from data/ratings.json, key "venue|race|runner" (lowercase venue)
      const x = RATINGS[m.venue.toLowerCase() + '|' + m.no + '|' + h.no] || {};
      return { no: h.no, name: h.name, odds: h.odds, style: x.style || 'M', tips: x.tips || 0,
        probs: [x.ratings ?? null, x.sectionals ?? null, x.tipsters ?? null, cons ? cons[i] : null, x.speed ?? null] };
    });
    if (!meetings.has(m.venue)) meetings.set(m.venue, { name: m.venue, country: m.country, region: /^(australia|new zealand)$/i.test(m.country) ? 'anz' : 'int', sky: false, races: [] });
    meetings.get(m.venue).races.push({ n: m.no, start: m.start, runners: rows });
  }
  const list = [...meetings.values()];
  list.forEach((m) => m.races.sort((a, b) => a.n - b.n));
  return { updated: new Date(now).toISOString(), sources: srcs.map((s) => s.name), meetings: list };
}
