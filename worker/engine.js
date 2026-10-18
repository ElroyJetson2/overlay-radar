// Independent sources = slots 0 (Hub/own ratings), 2 (tipsters), 4 (speed/sectionals). Slot 3 is the market and slot 1 (BSP form model)
// is built from the market, so neither counts as independent agreement.
// Server-side copy of the page's analysis (analyse() in site/index.html). Parity-tested against it; keep in sync.
// Overlay % = best bookmaker price / fair price - 1. Agreement is counted among INDEPENDENT ratings only (never the market).
export const W = [0.25, 0.2, 0.15, 0.25, 0.15]; // ratings, form model, tipsters, calibrated market consensus, pace-neutral speed
const PM = { Hot: { L: 0.85, P: 0.95, M: 1, OM: 1.1, BM: 1.15 }, Slow: { L: 1.2, P: 1.1, M: 1, OM: 0.92, BM: 0.85 }, Genuine: { L: 1, P: 1, M: 1.03, OM: 1.02, BM: 0.97 } };

export function analyseRace(runners, up = true, th = 0.3) {
  const n = runners.length;
  const lp = runners.filter((h) => h.style === 'L').length + 0.5 * runners.filter((h) => h.style === 'P').length;
  const shape = lp >= 3 ? 'Hot' : lp <= 1.5 ? 'Slow' : 'Genuine';
  const val = (h, i) => {
    const v = h.probs ? h.probs[i] : null;
    if (v == null) return null;
    return i === 4 ? v * (PM[shape][h.style || 'M'] || 1) : v;
  };
  const tot = [0, 1, 2, 3, 4].map((i) => (runners.every((h) => val(h, i) != null) ? runners.reduce((a, h) => a + val(h, i), 0) : 0));
  const AV = tot.map((x) => x > 0), na = AV.filter(Boolean).length, wsum = W.reduce((a, w, i) => a + (AV[i] ? w : 0), 0);
  const out = runners.map((h) => {
    const np = [0, 1, 2, 3, 4].map((i) => (AV[i] ? val(h, i) / tot[i] : null));
    const fp = na ? np.reduce((a, x, i) => a + (x == null ? 0 : x * W[i]), 0) / wsum : 1 / n;
    const fair = 1 / fp;
    const prices = Object.entries(h.odds || {}).filter(([, v]) => v > 0);
    const best = Math.max(0, ...prices.map(([, v]) => v)), bk = (prices.find(([, v]) => v === best) || [])[0];
    const ov = best / fair - 1;
    const IND = [0, 2, 4].filter((i) => np[i] != null), nI = IND.length;
    const fairI = nI ? IND.reduce((a, i) => a + W[i], 0) / IND.reduce((a, i) => a + np[i] * W[i], 0) : null;
    const agI = IND.filter((i) => np[i] > 1 / best).length;
    const al = up && na > 0 && ov > th && (!nI || agI >= Math.ceil(0.8 * nI));
    const k = Math.max(0, (0.25 * (fp * best - 1)) / (best - 1));
    return { no: h.no, name: h.name, style: h.style || 'M', fp, fair, fairI, best, bk, ov, na, nI, agI, al, k, mt: false };
  });
  const cand = out.filter((h) => h.fp >= 0.2 && h.ov >= 0.08 && h.nI > 0 && h.agI >= Math.ceil(0.8 * h.nI) && (PM[shape][h.style] || 1) >= 0.98).sort((a, b) => b.fp - a.fp);
  const mtip = (up && cand[0]) || null;
  if (mtip) mtip.mt = true;
  return { shape, runners: out, mtip };
}
