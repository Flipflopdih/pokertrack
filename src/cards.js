// ── Cards & hand evaluation (pure, no dependencies) ──
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['s','h','d','c'];
const RV = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,T:10,J:11,Q:12,K:13,A:14};

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
  return d;
}

function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) {
    const j = 0 | Math.random() * (i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function combos(arr, k) {
  if (!k) return [[]];
  if (arr.length === k) return [arr];
  const [f, ...r] = arr;
  return [...combos(r, k - 1).map(c => [f, ...c]), ...combos(r, k)];
}

function isStraight(vs) {
  const u = [...new Set(vs)];
  if (u.length < 5) return false;
  if (u[0] === 14 && u[1] === 5 && u[2] === 4 && u[3] === 3 && u[4] === 2) return true;
  return u[0] - u[4] === 4;
}

function eval5(cards) {
  const vs = cards.map(c => RV[c.r]).sort((a, b) => b - a);
  const ss = cards.map(c => c.s);
  const fl = ss.every(s => s === ss[0]);
  const st = isStraight(vs);
  const cnt = {};
  vs.forEach(v => cnt[v] = (cnt[v] || 0) + 1);
  const grp = Object.entries(cnt).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const g = grp.map(x => +x[1]);
  let rank, name;
  if (fl && st)                 { rank = 8; name = vs[0] === 14 && vs[1] === 13 ? 'Royal Flush' : 'Straight Flush'; }
  else if (g[0] === 4)          { rank = 7; name = 'Four of a Kind'; }
  else if (g[0] === 3 && g[1] === 2) { rank = 6; name = 'Full House'; }
  else if (fl)                  { rank = 5; name = 'Flush'; }
  else if (st)                  { rank = 4; name = 'Straight'; }
  else if (g[0] === 3)          { rank = 3; name = 'Three of a Kind'; }
  else if (g[0] === 2 && g[1] === 2) { rank = 2; name = 'Two Pair'; }
  else if (g[0] === 2)          { rank = 1; name = 'One Pair'; }
  else                          { rank = 0; name = 'High Card'; }
  // Tiebreak vector: straights compare by the top of the run (wheel = 5-high);
  // everything else compares group-by-group (pairs/trips before kickers).
  let order;
  if (st) {
    const top = (vs[0] === 14 && vs[1] === 5) ? 5 : vs[0];
    order = [0, 1, 2, 3, 4].map(i => top - i);
  } else {
    order = grp.flatMap(([v, c]) => Array(+c).fill(+v));
  }
  return { rank, name, vs: order };
}

function evalBest(cards) {
  if (cards.length === 5) return eval5(cards);
  let best = null;
  for (const c of combos(cards, 5)) {
    const e = eval5(c);
    if (!best || cmpE(e, best) > 0) best = e;
  }
  return best;
}

function cmpE(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < a.vs.length; i++) if (a.vs[i] !== b.vs[i]) return a.vs[i] - b.vs[i];
  return 0;
}

// ── FAST 7-card scorer (returns a single comparable number; higher = better) ──
// Used in the Monte-Carlo equity loops where we only need to compare, not name.
const SU = { s: 0, h: 1, d: 2, c: 3 };
function straightHigh(mask) {
  let m = mask;
  if (m & (1 << 14)) m |= 1 << 1; // ace plays low for the wheel
  for (let hi = 14; hi >= 5; hi--) {
    const need = (1 << hi) | (1 << (hi - 1)) | (1 << (hi - 2)) | (1 << (hi - 3)) | (1 << (hi - 4));
    if ((m & need) === need) return hi;
  }
  return 0;
}
function score7(cards) {
  const rc = new Array(15).fill(0);
  const sc = [0, 0, 0, 0];
  const suitMask = [0, 0, 0, 0];
  let rankMask = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i], v = RV[c.r], su = SU[c.s];
    rc[v]++; sc[su]++; suitMask[su] |= 1 << v; rankMask |= 1 << v;
  }
  let flushSuit = -1;
  for (let i = 0; i < 4; i++) if (sc[i] >= 5) flushSuit = i;
  if (flushSuit >= 0) { const sf = straightHigh(suitMask[flushSuit]); if (sf) return 8e10 + sf; }
  let quads = 0; const trips = [], pairs = [];
  for (let v = 14; v >= 2; v--) {
    if (rc[v] === 4) quads = v; else if (rc[v] === 3) trips.push(v); else if (rc[v] === 2) pairs.push(v);
  }
  if (quads) { let k = 0; for (let v = 14; v >= 2; v--) if (v !== quads && rc[v]) { k = v; break; } return 7e10 + quads * 15 + k; }
  if (trips.length && (pairs.length || trips.length >= 2)) {
    const t = trips[0], p = trips.length >= 2 ? trips[1] : pairs[0];
    return 6e10 + t * 15 + p;
  }
  if (flushSuit >= 0) { let s = 0, n = 0; for (let v = 14; v >= 2 && n < 5; v--) if (suitMask[flushSuit] & (1 << v)) { s = s * 15 + v; n++; } return 5e10 + s; }
  const st = straightHigh(rankMask);
  if (st) return 4e10 + st;
  if (trips.length) { const t = trips[0]; let s = 0, n = 0; for (let v = 14; v >= 2 && n < 2; v--) if (v !== t && rc[v]) { s = s * 15 + v; n++; } return 3e10 + t * 225 + s; }
  if (pairs.length >= 2) { const p1 = pairs[0], p2 = pairs[1]; let k = 0; for (let v = 14; v >= 2; v--) if (v !== p1 && v !== p2 && rc[v]) { k = v; break; } return 2e10 + p1 * 225 + p2 * 15 + k; }
  if (pairs.length === 1) { const p = pairs[0]; let s = 0, n = 0; for (let v = 14; v >= 2 && n < 3; v--) if (v !== p && rc[v]) { s = s * 15 + v; n++; } return 1e10 + p * 3375 + s; }
  let s = 0, n = 0; for (let v = 14; v >= 2 && n < 5; v--) if (rc[v]) { s = s * 15 + v; n++; }
  return s;
}

module.exports = { RANKS, SUITS, RV, makeDeck, shuffle, combos, isStraight, eval5, evalBest, cmpE, score7 };
