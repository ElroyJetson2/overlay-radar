// Push notifications for big overlays. Runs inside the cron refresh, so it works while your phone/browser is closed.
// Channels (any combination): ntfy (NTFY_TOPIC), Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID), Discord (DISCORD_WEBHOOK).
// Settings: NOTIFY_MIN_OVERLAY (percent, default 80), NOTIFY_WINDOW_MIN (only races jumping within N minutes, default 90),
// NOTIFY_OUTLIERS=true to also alert on price outliers that have no independent rating behind them (default off: they are
// often a single stale or erroneous price).
import { analyseRace } from './engine.js';

const vk = (s) => String(s || '').replace(/\(.*?\)/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const money = (n) => '$' + Number(n).toFixed(2);

export function channels(env) {
  const out = [];
  if (env.NTFY_TOPIC) out.push({ name: 'ntfy', send: async (m) => {
    const r = await fetch(env.NTFY_SERVER || 'https://ntfy.sh', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: env.NTFY_TOPIC, title: m.title, message: m.message, priority: 4, tags: ['rotating_light'], ...(env.SITE_URL ? { click: env.SITE_URL } : {}) }) });
    if (!r.ok) throw new Error('ntfy ' + r.status);
  } });
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) out.push({ name: 'telegram', send: async (m) => {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: m.title + '\n' + m.message }) });
    if (!r.ok) throw new Error('telegram ' + r.status);
  } });
  if (env.DISCORD_WEBHOOK) out.push({ name: 'discord', send: async (m) => {
    const r = await fetch(env.DISCORD_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '**' + m.title + '**\n' + m.message }) });
    if (!r.ok) throw new Error('discord ' + r.status);
  } });
  return out;
}

export async function sendAll(env, msg) {
  const ch = channels(env);
  const res = await Promise.allSettled(ch.map((c) => c.send(msg)));
  return ch.map((c, i) => ({ channel: c.name, ok: res[i].status === 'fulfilled', error: res[i].status === 'rejected' ? String(res[i].reason) : undefined }));
}

export async function notify(env, st, feed, now) {
  const min = (+env.NOTIFY_MIN_OVERLAY || 80) / 100, win = +env.NOTIFY_WINDOW_MIN || 90, outliers = env.NOTIFY_OUTLIERS === 'true';
  const ch = channels(env);
  feed.notify = { min: Math.round(min * 100), on: ch.length > 0 };
  if (!ch.length) return;
  st.notified = st.notified || {};
  for (const [k, v] of Object.entries(st.notified)) if (now - v.ts > 24 * 36e5) delete st.notified[k];
  const hits = [];
  for (const m of feed.meetings) for (const r of m.races) {
    const mins = (Date.parse(r.start) - now) / 6e4;
    if (!(mins > 1 && mins <= win)) continue; // can't back a race that has jumped
    for (const h of analyseRace(r.runners, true, min).runners) if (h.al && (h.nI > 0 || outliers)) hits.push({ m, r, h, mins });
  }
  hits.sort((a, b) => b.h.ov - a.h.ov);
  const info = { last: (st.notifyInfo || {}).last, sent: 0, errors: [] };
  for (const { m, r, h, mins } of hits.slice(0, 5)) {
    const key = vk(m.name) + '|' + (m.code || 'horse') + '|' + r.n + '|' + h.no, prev = st.notified[key];
    if (prev && h.ov < prev.ov + 0.25) continue; // already told you; only repeat if it got 25 points bigger
    const why = h.nI ? `${h.agI}/${h.nI} independent ratings agree` : 'price outlier, no independent rating';
    const msg = {
      title: `🚨 +${Math.round(h.ov * 100)}% ${m.code === 'greyhound' ? '🐕 ' : ''}${m.name} R${r.n} #${h.no} ${String(h.name || '').replace(/^\s*\d+\.\s*/, '')}`,
      message: `${money(h.best)} at ${h.bk} vs ${h.fairI ? 'indicators ' + money(h.fairI) + ' (blended fair ' + money(h.fair) + ')' : 'fair ' + money(h.fair)}. ${Math.round(h.fp * 100)}% win chance, ${why}. Jumps in ${Math.round(mins)} min.`,
    };
    const res = await sendAll(env, msg);
    if (res.some((x) => x.ok)) { st.notified[key] = { ts: now, ov: h.ov }; info.sent++; info.last = now; }
    res.filter((x) => !x.ok).forEach((x) => info.errors.push(x.channel + ': ' + x.error));
  }
  st.notifyInfo = info;
}
