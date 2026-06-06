// ── GTO scoring: preflop heuristics (Chen) + postflop Monte-Carlo equity ──
const { RV, makeDeck, evalBest, cmpE } = require('./cards');

// Legacy "luck"/label helper still used for hand-log labels and the luck meter.
function pfStr(c1, c2) {
  const v1 = RV[c1.r], v2 = RV[c2.r], hi = Math.max(v1, v2), lo = Math.min(v1, v2);
  const suited = c1.s === c2.s, pair = c1.r === c2.r;
  let pts = 0, label = '', premium = false;
  if (pair) {
    pts = hi >= 13 ? 10 : hi >= 11 ? 9 : hi >= 9 ? 7 : hi >= 7 ? 5 : 3;
    label = hi >= 13 ? 'Premium pair' : hi >= 10 ? 'Strong pair' : 'Pocket pair';
    premium = hi >= 11;
  } else {
    pts = (hi === 14 ? 6 : hi === 13 ? 5 : hi === 12 ? 4 : hi >= 10 ? 3 : 2) + (lo >= 12 ? 2 : lo >= 10 ? 1 : 0) + (suited ? 2 : 0) + (hi - lo <= 1 ? 1 : 0);
    label = hi === 14 && lo >= 13 ? 'Ace-King' : hi === 14 ? 'Ace-high' : suited && hi - lo <= 2 && hi >= 10 ? 'Suited connector' : hi >= 12 ? 'Strong offsuit' : suited ? 'Suited hand' : 'Speculative';
    premium = (hi === 14 && lo >= 11) || (suited && hi - lo <= 1 && hi >= 11);
  }
  return { pts, label, premium, lp: premium ? 3 : pts >= 6 ? 2 : pts >= 4 ? 1 : 0 };
}

// Chen formula — a well-established preflop hand-ranking heuristic.
function chenScore(c1, c2) {
  const hi = Math.max(RV[c1.r], RV[c2.r]);
  const lo = Math.min(RV[c1.r], RV[c2.r]);
  const suited = c1.s === c2.s, pair = c1.r === c2.r;
  const hc = v => v === 14 ? 10 : v === 13 ? 8 : v === 12 ? 7 : v === 11 ? 6 : v / 2;
  let s = hc(hi);
  if (pair) return Math.round(Math.max(5, s * 2));
  if (suited) s += 2;
  const gap = hi - lo - 1;
  if (gap === 1) s -= 1; else if (gap === 2) s -= 2; else if (gap === 3) s -= 4; else if (gap >= 4) s -= 5;
  if (gap <= 1 && hi < 12) s += 1;
  return Math.ceil(s);
}

// Position label relative to the button, plus open thresholds.
function posLabel(offset, n) {
  if (n === 2) return offset === 0 ? 'SB' : 'BB';
  if (offset === 0) return 'BTN';
  if (offset === 1) return 'SB';
  if (offset === 2) return 'BB';
  if (offset === n - 1) return 'CO';
  const afterBB = offset - 2, total = n - 3;
  return afterBB <= Math.ceil(total / 2) ? 'UTG' : 'MP';
}
const OPEN_THRESH = { UTG: 10, MP: 9, CO: 8, BTN: 6, SB: 7, BB: 6 };

// Monte-Carlo equity of `hole` vs `nOpp` random opponents on the current board.
function monteCarloEquity(hole, board, nOpp, iters) {
  const used = new Set([...hole, ...board].map(c => c.r + c.s));
  const base = makeDeck().filter(c => !used.has(c.r + c.s));
  const need = nOpp * 2 + (5 - board.length);
  if (need > base.length) return null;
  let score = 0;
  for (let i = 0; i < iters; i++) {
    const d = base; // partial Fisher-Yates of the unseen cards
    for (let k = 0; k < need; k++) {
      const j = k + (0 | Math.random() * (d.length - k));
      const t = d[k]; d[k] = d[j]; d[j] = t;
    }
    const fullBoard = board.concat(d.slice(0, 5 - board.length));
    let idx = 5 - board.length;
    const heroEv = evalBest(hole.concat(fullBoard));
    let lost = false, tied = false;
    for (let o = 0; o < nOpp; o++) {
      const oppEv = evalBest([d[idx], d[idx + 1]].concat(fullBoard));
      idx += 2;
      const c = cmpE(oppEv, heroEv);
      if (c > 0) { lost = true; break; }
      if (c === 0) tied = true;
    }
    if (!lost) score += tied ? 0.5 : 1;
  }
  return score / iters;
}

const pct = x => Math.round(x * 100);

// Score a single decision; returns { correct, note, eq, chen }.
function scoreGTO(ctx) {
  const { action, street, position } = ctx;
  let correct, note;

  if (street === 'preflop') {
    const chen = ctx.chen, thr = OPEN_THRESH[position] || 8, facing = ctx.facingRaise;
    const tag = `${position} (Chen ${chen})`;
    if (!facing) {
      if (action === 'fold') {
        correct = chen < thr;
        note = correct ? `Fine fold — ${tag} is below the ~${thr} open range` : `Too tight — ${tag} is a standard open from ${position}`;
      } else if (action === 'check') {
        correct = chen < thr + 3;
        note = correct ? `Checking your BB option is fine with ${tag}` : `Premium — ${tag} should raise for value, not check`;
      } else if (action === 'raise' || action === 'allin') {
        correct = chen >= thr;
        note = correct ? `Good open — ${tag} is in range for ${position}` : `Loose open — ${tag} is below the ~${thr} range for ${position}`;
      } else {
        correct = false;
        note = `Limping leaks EV — raise or fold ${tag} instead`;
      }
    } else {
      const callThr = thr + 1, threeBetThr = thr + 5;
      if (action === 'fold') {
        correct = chen < callThr;
        note = correct ? `Correct fold vs the raise — ${tag} is too weak to continue` : `${tag} is strong enough to continue vs a raise`;
      } else if (action === 'raise' || action === 'allin') {
        correct = chen >= threeBetThr;
        note = correct ? `Strong 3-bet — ${tag} plays great for value` : `Thin 3-bet — ${tag} usually prefers calling here`;
      } else {
        correct = chen >= callThr && chen < threeBetThr;
        note = correct ? `Reasonable call vs the raise with ${tag}` : chen >= threeBetThr ? `${tag} is strong enough to 3-bet, not just call` : `Calling off-range — ${tag} is a fold vs a raise`;
      }
    }
    return { correct, note, eq: null, chen };
  }

  // postflop — equity-driven
  const eq = ctx.equity, odds = ctx.potOdds, e = pct(eq), o = pct(odds);
  if (action === 'fold') {
    correct = eq < odds + 0.02;
    note = correct ? `Fine fold — ~${e}% equity vs ${o}% needed to call` : `Too weak a fold — ~${e}% equity beats the ${o}% you needed`;
  } else if (action === 'check') {
    if (eq >= 0.7) { correct = false; note = `Missed value — ~${e}% equity wants a bet, not a check`; }
    else { correct = true; note = `Checking is fine here (~${e}% equity)`; }
  } else if (action === 'raise' || action === 'allin') {
    correct = eq >= 0.55;
    note = correct ? `Good value raise — ~${e}% equity` : `Thin raise — only ~${e}% equity; check/call is usually better`;
  } else {
    correct = eq + 0.02 >= odds;
    note = correct ? `Good call — ~${e}% equity vs ${o}% pot odds` : `Loose call — ~${e}% equity isn't enough vs ${o}% pot odds`;
  }
  return { correct, note, eq, chen: null };
}

module.exports = { pfStr, chenScore, posLabel, OPEN_THRESH, monteCarloEquity, scoreGTO };
