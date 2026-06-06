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

module.exports = { RANKS, SUITS, RV, makeDeck, shuffle, combos, isStraight, eval5, evalBest, cmpE };
