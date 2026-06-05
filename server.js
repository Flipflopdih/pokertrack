const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── ROOMS ──
const rooms = {};
function makeCode() { return Math.random().toString(36).substr(2,6).toUpperCase(); }

// ── CARDS ──
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['s','h','d','c'];
const RV = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,T:10,J:11,Q:12,K:13,A:14};

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({r,s});
  return d;
}
function shuffle(d) {
  for (let i=d.length-1;i>0;i--) {
    const j=0|Math.random()*(i+1);
    [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}

// ── EVAL ──
function evalBest(cards) {
  if (cards.length === 5) return eval5(cards);
  let best = null;
  for (const c of combos(cards,5)) {
    const e = eval5(c);
    if (!best || cmpE(e,best)>0) best = e;
  }
  return best;
}
function combos(arr,k) {
  if (!k) return [[]];
  if (arr.length===k) return [arr];
  const [f,...r] = arr;
  return [...combos(r,k-1).map(c=>[f,...c]),...combos(r,k)];
}
function eval5(cards) {
  const vs = cards.map(c=>RV[c.r]).sort((a,b)=>b-a);
  const ss = cards.map(c=>c.s);
  const fl = ss.every(s=>s===ss[0]);
  const st = isStraight(vs);
  const cnt = {};
  vs.forEach(v=>cnt[v]=(cnt[v]||0)+1);
  const grp = Object.entries(cnt).sort((a,b)=>b[1]-a[1]||b[0]-a[0]);
  const g = grp.map(x=>+x[1]);
  let rank, name;
  if (fl&&st)      { rank=8; name=vs[0]===14&&vs[1]===13?'Royal Flush':'Straight Flush'; }
  else if (g[0]===4)              { rank=7; name='Four of a Kind'; }
  else if (g[0]===3&&g[1]===2)    { rank=6; name='Full House'; }
  else if (fl)                    { rank=5; name='Flush'; }
  else if (st)                    { rank=4; name='Straight'; }
  else if (g[0]===3)              { rank=3; name='Three of a Kind'; }
  else if (g[0]===2&&g[1]===2)    { rank=2; name='Two Pair'; }
  else if (g[0]===2)              { rank=1; name='One Pair'; }
  else                            { rank=0; name='High Card'; }
  return { rank, name, vs };
}
function isStraight(vs) {
  const u=[...new Set(vs)];
  if (u.length<5) return false;
  if (u[0]===14&&u[1]===5&&u[2]===4&&u[3]===3&&u[4]===2) return true;
  return u[0]-u[4]===4;
}
function cmpE(a,b) {
  if (a.rank!==b.rank) return a.rank-b.rank;
  for (let i=0;i<a.vs.length;i++) if (a.vs[i]!==b.vs[i]) return a.vs[i]-b.vs[i];
  return 0;
}

// ── PREFLOP STRENGTH (for GTO) ──
function pfStr(c1,c2) {
  const v1=RV[c1.r],v2=RV[c2.r],hi=Math.max(v1,v2),lo=Math.min(v1,v2);
  const suited=c1.s===c2.s,pair=c1.r===c2.r;
  let pts=0,label='',premium=false;
  if (pair) {
    pts=hi>=13?10:hi>=11?9:hi>=9?7:hi>=7?5:3;
    label=hi>=13?'Premium pair':hi>=10?'Strong pair':'Pocket pair';
    premium=hi>=11;
  } else {
    pts=(hi===14?6:hi===13?5:hi===12?4:hi>=10?3:2)+(lo>=12?2:lo>=10?1:0)+(suited?2:0)+(hi-lo<=1?1:0);
    label=hi===14&&lo>=13?'Ace-King':hi===14?'Ace-high':suited&&hi-lo<=2&&hi>=10?'Suited connector':hi>=12?'Strong offsuit':suited?'Suited hand':'Speculative';
    premium=(hi===14&&lo>=11)||(suited&&hi-lo<=1&&hi>=11);
  }
  return {pts,label,premium,lp:premium?3:pts>=6?2:pts>=4?1:0};
}

// ── PREFLOP STRENGTH: Chen formula (well-established hand-ranking heuristic) ──
function chenScore(c1, c2) {
  const hi = Math.max(RV[c1.r], RV[c2.r]);
  const lo = Math.min(RV[c1.r], RV[c2.r]);
  const suited = c1.s === c2.s, pair = c1.r === c2.r;
  const hc = v => v === 14 ? 10 : v === 13 ? 8 : v === 12 ? 7 : v === 11 ? 6 : v / 2;
  let s = hc(hi);
  if (pair) return Math.round(Math.max(5, s * 2)); // pairs: twice high card, min 5
  if (suited) s += 2;
  const gap = hi - lo - 1; // cards between
  if (gap === 1) s -= 1; else if (gap === 2) s -= 2; else if (gap === 3) s -= 4; else if (gap >= 4) s -= 5;
  if (gap <= 1 && hi < 12) s += 1; // 0/1-gap straight bonus, both below Q
  return Math.ceil(s);
}

// Position label + open threshold relative to the button.
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

// ── MONTE-CARLO EQUITY vs N random opponents ──
function monteCarloEquity(hole, board, nOpp, iters) {
  const used = new Set([...hole, ...board].map(c => c.r + c.s));
  const base = makeDeck().filter(c => !used.has(c.r + c.s));
  const need = nOpp * 2 + (5 - board.length);
  if (need > base.length) return null;
  let score = 0;
  const heroSeven = new Array(7);
  for (let i = 0; i < iters; i++) {
    // partial Fisher-Yates of the unseen cards
    const d = base;
    for (let k = 0; k < need; k++) {
      const j = k + (0 | Math.random() * (d.length - k));
      const t = d[k]; d[k] = d[j]; d[j] = t;
    }
    let idx = 0;
    const fullBoard = board.concat(d.slice(0, 5 - board.length));
    idx = 5 - board.length;
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

function pct(x) { return Math.round(x * 100); }

// ── GTO SCORING (preflop heuristics + postflop equity) ──
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
      } else { // limp/call into unraised pot
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
  } else { // call
    correct = eq + 0.02 >= odds;
    note = correct ? `Good call — ~${e}% equity vs ${o}% pot odds` : `Loose call — ~${e}% equity isn't enough vs ${o}% pot odds`;
  }
  return { correct, note, eq, chen: null };
}

function mkStat(startChips) {
  return {startChips,chips:startChips,handsPlayed:0,handsWon:0,vpip:0,folds:0,ghostWins:0,luckPts:0,luckHands:0,gtoDecisions:[],chipHistory:[startChips],handLog:[]};
}

// ── ROOM CREATION ──
function createRoom(hostName, hostSocketId, startChips, sb, bb, maxSeats) {
  const code = makeCode();
  rooms[code] = {
    code,
    hostId: hostSocketId,
    sb, bb,
    startChips,
    maxSeats: Math.max(2, Math.min(8, maxSeats || 8)),
    seats: Array(8).fill(null), // 8 seats, null = empty
    // seat: { id, name, socketId, chips, stat, cards, bet, folded, lastAction, seatIndex, curPF }
    dealer: -1, // seat index of dealer
    handNum: 0,
    deck: [], di: 0,
    pot: 0, board: [],
    curBet: 0, street: '',
    queue: [], // array of seatIndexes in action order
    over: true,
    actionTimer: null,
    phase: 'waiting', // waiting | playing
    sidePots: []
  };
  return code;
}

function getRoom(code) { return rooms[code.toUpperCase()]; }

function filledSeats(room) { return room.seats.filter(Boolean); }
function activePlayers(room) { return room.seats.filter(s=>s&&!s.folded); }

function seatPlayer(room, seatIndex, name, socketId, chips) {
  room.seats[seatIndex] = {
    id: socketId,
    name,
    socketId,
    chips,
    stat: mkStat(chips),
    cards: [],
    bet: 0,
    committed: 0,
    folded: false,
    lastAction: '',
    seatIndex,
    curPF: null,
    connected: true
  };
}

// Move chips from a player's stack into the pot, tracking total commitment for side pots.
function commit(room, p, amt) {
  const pay = Math.min(amt, p.chips);
  p.chips -= pay; p.bet += pay; p.committed += pay; room.pot += pay;
  return pay;
}

function seatOfSocket(room, socketId) {
  return room.seats.findIndex(s => s && s.socketId === socketId);
}

function broadcast(room) {
  filledSeats(room).forEach(p => {
    if (!p.socketId) return;
    io.to(p.socketId).emit('state', buildView(room, p.socketId));
  });
  // also send to spectators in the room
  io.to(room.code).emit('state_public', buildPublicView(room));
}

function buildView(room, socketId) {
  return {
    code: room.code,
    handNum: room.handNum,
    pot: room.pot,
    board: room.board,
    street: room.street,
    curBet: room.curBet,
    over: room.over,
    phase: room.phase,
    sb: room.sb,
    bb: room.bb,
    maxSeats: room.maxSeats,
    startChips: room.startChips,
    isHost: room.hostId === socketId,
    seats: room.seats.map((s,i) => s ? {
      seatIndex: i,
      id: s.id,
      name: s.name,
      chips: s.chips,
      bet: s.bet,
      folded: s.folded,
      lastAction: s.lastAction,
      isDealer: i === room.dealer,
      isTurn: !room.over && room.queue[0] === i,
      isYou: s.socketId === socketId,
      cards: s.socketId === socketId ? s.cards : (room.over ? s.cards : s.cards.map(()=>null)),
      connected: s.connected
    } : null
    )
  };
}

function buildPublicView(room) {
  // same as buildView but no private cards
  return {
    code: room.code,
    handNum: room.handNum,
    pot: room.pot,
    board: room.board,
    street: room.street,
    curBet: room.curBet,
    over: room.over,
    phase: room.phase,
    sb: room.sb,
    bb: room.bb,
    maxSeats: room.maxSeats,
    startChips: room.startChips,
    seats: room.seats.map((s,i) => s ? {
      seatIndex: i,
      id: s.id,
      name: s.name,
      chips: s.chips,
      bet: s.bet,
      folded: s.folded,
      lastAction: s.lastAction,
      isDealer: i === room.dealer,
      isTurn: !room.over && room.queue[0] === i,
      connected: s.connected
    } : null)
  };
}

// ── DEAL ──
function dealHand(room) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
  const players = filledSeats(room);
  if (players.length < 2) {
    room.phase = 'waiting';
    broadcast(room);
    return;
  }
  room.handNum++;
  room.phase = 'playing';
  const deck = shuffle(makeDeck());
  room.deck = deck; room.di = 0; room.pot = 0; room.board = [];
  room.curBet = room.bb; room.street = 'preflop'; room.over = false;

  players.forEach(p => {
    p.folded = false; p.cards = []; p.bet = 0; p.committed = 0; p.lastAction = '';
    if (p.chips <= 0) p.chips = room.startChips;
  });

  // advance dealer to next filled seat
  const filled = room.seats.map((s,i)=>s?i:-1).filter(i=>i>=0);
  if (room.dealer === -1 || filled.indexOf(room.dealer) === -1) {
    room.dealer = filled[0];
  } else {
    const cur = filled.indexOf(room.dealer);
    room.dealer = filled[(cur+1)%filled.length];
  }

  // deal 2 cards each
  for (let i=0;i<2;i++) players.forEach(p=>p.cards.push(deck[room.di++]));

  // preflop luck
  players.forEach(p => {
    const ps = pfStr(p.cards[0], p.cards[1]);
    p.stat.luckPts += ps.lp;
    p.stat.luckHands++;
    p.curPF = ps;
  });

  // Post blinds. Heads-up: the dealer is the small blind and acts first preflop.
  let sbIdx, bbIdx, startIdx;
  if (players.length === 2) {
    sbIdx = room.dealer;
    bbIdx = nextSeat(room, room.dealer);
    startIdx = sbIdx;
  } else {
    sbIdx = nextSeat(room, room.dealer);
    bbIdx = nextSeat(room, sbIdx);
    startIdx = nextSeat(room, bbIdx); // action starts left of BB
  }
  postBlind(room, sbIdx, room.sb);
  postBlind(room, bbIdx, room.bb);

  room.queue = buildQueue(room, startIdx);

  broadcast(room);
  scheduleNext(room);
}

function nextSeat(room, fromIdx) {
  // find next occupied seat after fromIdx (wrapping)
  for (let i=1;i<=8;i++) {
    const idx = (fromIdx+i)%8;
    if (room.seats[idx]) return idx;
  }
  return fromIdx;
}

function postBlind(room, seatIdx, amt) {
  const p = room.seats[seatIdx];
  if (!p) return;
  const pay = commit(room, p, amt);
  p.lastAction = 'Blind ' + pay;
}

function buildQueue(room, startSeatIdx, excludeIdx) {
  // Ordered list of seats that still need to act, starting from startSeatIdx.
  // Skips folded players, all-in players (no chips) and an optional excluded seat
  // (the aggressor, who shouldn't act again until re-raised).
  const q = [];
  let idx = startSeatIdx;
  for (let i=0;i<8;i++) {
    const seat = room.seats[idx];
    if (seat && !seat.folded && seat.chips > 0 && idx !== excludeIdx) q.push(idx);
    idx = nextSeat(room, idx);
    if (idx === startSeatIdx) break;
  }
  return q;
}

function scheduleNext(room) {
  if (room.over) return;
  if (activePlayers(room).length <= 1) { endHand(room); return; }
  if (!room.queue.length) { advStreet(room); return; }

  const seatIdx = room.queue[0];
  const player = room.seats[seatIdx];
  if (!player) { room.queue.shift(); scheduleNext(room); return; }

  // Set 30s timeout for disconnected players
  if (!player.connected) {
    room.actionTimer = setTimeout(() => {
      applyAction(room, seatIdx, 'fold');
      broadcast(room);
      scheduleNext(room);
    }, 3000);
  }
  // Otherwise wait for socket event
  broadcast(room);
}

// ── APPLY ACTION ──
function applyAction(room, seatIdx, action, raiseAmt) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
  if (room.over) return false;
  if (!room.queue.length || room.queue[0] !== seatIdx) return false;

  const p = room.seats[seatIdx];
  if (!p || p.folded) return false;

  const call = Math.max(0, room.curBet - p.bet);

  if (action === 'fold') {
    p.folded = true;
    p.lastAction = 'Fold';
    p.stat.folds++;
    trackGTO(room, p, 'fold');
  } else if (action === 'check') {
    if (call > 0) return false; // can't check if there's a bet
    p.lastAction = 'Check';
    p.stat.vpip++;
    trackGTO(room, p, 'check');
  } else if (action === 'call') {
    if (call === 0) return false;
    const pay = commit(room, p, call);
    p.lastAction = pay < call ? 'All-in ' + p.bet : 'Call ' + pay;
    p.stat.vpip++;
    trackGTO(room, p, 'call');
  } else if (action === 'raise') {
    if (p.chips <= call) return false; // not enough to raise — must call or go all-in
    const minRaise = room.curBet + room.bb;
    const target = Math.max(raiseAmt || 0, minRaise);
    const extra = Math.min(target - p.bet, p.chips);
    if (extra <= 0) return false;
    commit(room, p, extra);
    room.curBet = p.bet;
    p.lastAction = (p.chips === 0 ? 'All-in ' : 'Raise ') + p.bet;
    p.stat.vpip++;
    trackGTO(room, p, 'raise');
    // Everyone else still in needs to act again — rebuild queue excluding the raiser
    room.queue = buildQueue(room, nextSeat(room, seatIdx), seatIdx);
    return true;
  } else if (action === 'allin') {
    if (p.chips <= 0) return false;
    const wasRaise = (p.bet + p.chips) > room.curBet;
    commit(room, p, p.chips);
    p.lastAction = 'All-in ' + p.bet;
    p.stat.vpip++;
    trackGTO(room, p, wasRaise ? 'raise' : 'call');
    if (wasRaise) {
      // A real raise — reopen the action for everyone else still holding chips
      room.curBet = p.bet;
      room.queue = buildQueue(room, nextSeat(room, seatIdx), seatIdx);
      return true;
    }
    // All-in for less than (or equal to) the current bet — just a call, no reopen
  }

  room.queue.shift();
  return true;
}

function trackGTO(room, player, action) {
  const callAmt = Math.max(0, room.curBet - player.bet);
  const potOdds = room.pot > 0 ? callAmt / (room.pot + callAmt) : 0;

  // position relative to the button
  const filled = room.seats.map((s,i)=>s?i:-1).filter(i=>i>=0);
  const n = filled.length;
  const offset = (filled.indexOf(player.seatIndex) - filled.indexOf(room.dealer) + n) % n;
  const position = posLabel(offset, n);

  const ctx = { action, street: room.street, position, potOdds };
  if (room.street === 'preflop') {
    ctx.chen = player.cards.length === 2 ? chenScore(player.cards[0], player.cards[1]) : 0;
    ctx.facingRaise = room.curBet > room.bb;
  } else {
    const opps = Math.max(1, activePlayers(room).length - 1);
    const iters = opps <= 1 ? 240 : opps === 2 ? 180 : 140;
    ctx.equity = monteCarloEquity(player.cards, room.board, opps, iters) ?? 0;
  }

  const res = scoreGTO(ctx);
  player.stat.gtoDecisions.push({
    hand: room.handNum, street: room.street, action, position,
    correct: res.correct, note: res.note,
    equity: res.eq != null ? Math.round(res.eq*100) : null,
    chen: res.chen
  });
}

function advStreet(room) {
  filledSeats(room).forEach(p => p.bet = 0);
  room.curBet = 0;

  if (room.street==='preflop')      { room.board.push(room.deck[room.di++],room.deck[room.di++],room.deck[room.di++]); room.street='flop'; }
  else if (room.street==='flop')    { room.board.push(room.deck[room.di++]); room.street='turn'; }
  else if (room.street==='turn')    { room.board.push(room.deck[room.di++]); room.street='river'; }
  else { endHand(room); return; }

  // Post-flop action starts left of dealer
  const startIdx = nextSeat(room, room.dealer);
  room.queue = buildQueue(room, startIdx);
  broadcast(room);
  setTimeout(() => scheduleNext(room), 600);
}

// Split the pot into side pots based on each player's total commitment, then
// award each layer to the best eligible (non-folded) hand. Returns a per-player
// winnings map keyed by seatIndex.
function settlePots(room) {
  const totalPot = room.pot;
  const winnings = {};
  filledSeats(room).forEach(p => winnings[p.seatIndex] = 0);

  // Build pot layers from the distinct commitment levels.
  let contrib = filledSeats(room).map(p => ({ p, amt: p.committed })).filter(c => c.amt > 0);
  const layers = [];
  while (contrib.length) {
    const lvl = Math.min(...contrib.map(c => c.amt));
    let amount = 0;
    contrib.forEach(c => { amount += lvl; c.amt -= lvl; });
    const eligible = contrib.filter(c => !c.p.folded).map(c => c.p);
    layers.push({ amount, eligible });
    contrib = contrib.filter(c => c.amt > 0);
  }

  layers.forEach(layer => {
    if (!layer.amount) return;
    let recipients = layer.eligible;
    if (!recipients.length) return; // shouldn't happen, but never burn chips
    if (recipients.length > 1) {
      const evals = recipients.map(p => ({ p, ev: evalBest([...p.cards, ...room.board]) }));
      evals.sort((a,b) => cmpE(b.ev, a.ev));
      const best = evals[0].ev;
      recipients = evals.filter(e => cmpE(e.ev, best) === 0).map(e => e.p);
    }
    const share = Math.floor(layer.amount / recipients.length);
    let rem = layer.amount - share * recipients.length;
    recipients.forEach(w => { w.chips += share; winnings[w.seatIndex] += share; });
    // odd chip goes to the first eligible seat left of the dealer
    if (rem > 0) { recipients[0].chips += rem; winnings[recipients[0].seatIndex] += rem; }
  });

  return { winnings, totalPot };
}

function endHand(room) {
  room.over = true;
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }

  const active = activePlayers(room);
  const showdown = active.length > 1 && room.board.length === 5;

  const { winnings } = settlePots(room);

  // Primary winner = whoever collected the most (for the banner + hand name).
  let winner = null, best = -1;
  filledSeats(room).forEach(p => {
    if (winnings[p.seatIndex] > best) { best = winnings[p.seatIndex]; winner = p; }
  });
  if (!winner) winner = active[0] || filledSeats(room)[0];

  const winnerCount = filledSeats(room).filter(p => winnings[p.seatIndex] > 0).length;
  let handName = '';
  if (showdown && !winner.folded) {
    handName = evalBest([...winner.cards, ...room.board]).name;
    winner.lastAction = handName;
  }
  filledSeats(room).forEach(p => { if (winnings[p.seatIndex] > 0) p.stat.handsWon++; });

  // ghost wins — folded hands that would have beaten the eventual winner
  filledSeats(room).filter(p=>p.folded).forEach(p => {
    if (room.board.length >= 3 && winner && !winner.folded) {
      const ph = evalBest([...p.cards, ...room.board]);
      const wh = evalBest([...winner.cards, ...room.board]);
      if (cmpE(ph, wh) > 0) p.stat.ghostWins++;
    }
  });

  filledSeats(room).forEach(p => {
    p.stat.handsPlayed++;
    p.stat.chips = p.chips;
    p.stat.chipHistory.push(p.chips);
    if (p.curPF) {
      p.stat.handLog.push({
        num: room.handNum,
        cards: [...p.cards],
        board: [...room.board],
        pfLabel: p.curPF.label,
        pfPts: p.curPF.pts,
        won: winnings[p.seatIndex] > 0,
        folded: p.folded,
        ghostWin: p.folded && room.board.length>=3 && winner && !winner.folded && cmpE(evalBest([...p.cards,...room.board]), evalBest([...winner.cards,...room.board]))>0,
        winAmt: winnings[p.seatIndex] || 0
      });
    }
  });

  broadcast(room);

  // send hand_over event with winner info
  io.to(room.code).emit('hand_over', {
    winnerId: winner.id,
    winnerName: winnerCount > 1 ? 'Split pot' : winner.name,
    pot: room.pot,
    handName,
    seats: room.seats.map((s,i) => s ? {seatIndex:i, name:s.name, cards:s.cards, folded:s.folded} : null)
  });

  // next hand after 4s
  room.actionTimer = setTimeout(() => { if (rooms[room.code]) dealHand(room); }, 4000);
}

// ── SOCKET.IO ──
io.on('connection', socket => {
  let myRoom = null;
  let mySeat = null;

  socket.on('create_room', ({ name, startChips, sb, bb, maxSeats }) => {
    name = (name || '').toString().trim().slice(0, 14) || 'Host';
    startChips = Math.max(1, startChips || 1000);
    sb = Math.max(1, sb || 10);
    bb = Math.max(sb * 2, bb || 20); // big blind at least 2x small blind
    const code = createRoom(name, socket.id, startChips, sb, bb, maxSeats);
    myRoom = code;
    socket.join(code);
    const room = getRoom(code);
    // host takes seat 0
    seatPlayer(room, 0, name, socket.id, startChips);
    mySeat = 0;
    socket.emit('room_created', { code, url: '/room/'+code });
    broadcast(room);
  });

  socket.on('join_room', ({ code, name }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('err', 'Room not found'); return; }
    name = (name || '').toString().trim().slice(0, 14) || 'Player';
    // find first empty seat within the table size
    let emptyIdx = -1;
    for (let i = 0; i < room.maxSeats; i++) { if (!room.seats[i]) { emptyIdx = i; break; } }
    if (emptyIdx === -1) { socket.emit('err', 'Room is full'); return; }
    myRoom = room.code;
    mySeat = emptyIdx;
    socket.join(room.code);
    seatPlayer(room, emptyIdx, name, socket.id, room.startChips);
    socket.emit('joined_room', { code: room.code, seatIndex: emptyIdx });
    broadcast(room);
  });

  socket.on('take_seat', ({ code, seatIndex, name }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('err', 'Room not found'); return; }
    if (seatIndex < 0 || seatIndex >= room.maxSeats) return;
    if (room.seats[seatIndex]) { socket.emit('err', 'Seat taken'); return; }
    // Seats can only be changed between hands.
    if (room.phase === 'playing' && !room.over) { socket.emit('err', 'Wait for the hand to finish'); return; }

    const existingIdx = seatOfSocket(room, socket.id);
    if (existingIdx !== -1) {
      // Move the existing player to the new seat instead of creating a duplicate.
      const player = room.seats[existingIdx];
      player.seatIndex = seatIndex;
      room.seats[seatIndex] = player;
      room.seats[existingIdx] = null;
      if (room.dealer === existingIdx) room.dealer = seatIndex;
    } else {
      seatPlayer(room, seatIndex, (name || '').toString().trim().slice(0, 14) || 'Player', socket.id, room.startChips);
    }
    myRoom = room.code;
    mySeat = seatIndex;
    socket.join(room.code);
    socket.emit('joined_room', { code: room.code, seatIndex });
    broadcast(room);
  });

  socket.on('start_game', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    if (filledSeats(room).length < 2) { socket.emit('err', 'Need at least 2 players'); return; }
    dealHand(room);
  });

  socket.on('action', ({ code, action, amount }) => {
    const room = getRoom(code);
    if (!room || mySeat === null) return;
    const ok = applyAction(room, mySeat, action, amount||0);
    if (!ok) return;
    broadcast(room);
    scheduleNext(room);
  });

  socket.on('update_settings', ({ code, sb, bb, startChips }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    if (bb < sb*2) { socket.emit('err', 'Big blind must be at least 2x small blind'); return; }
    room.sb = sb;
    room.bb = bb;
    if (startChips) room.startChips = startChips;
    broadcast(room);
    io.to(room.code).emit('settings_updated', { sb, bb, startChips: room.startChips });
  });

  socket.on('update_chips', ({ code, seatIndex, chips }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    const p = room.seats[seatIndex];
    if (p) { p.chips = chips; broadcast(room); }
  });

  socket.on('end_session', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    room.over = true;
    if (room.actionTimer) clearTimeout(room.actionTimer);
    const stats = room.seats.filter(Boolean).map(p => ({
      name: p.name, seatIndex: p.seatIndex,
      chips: p.chips, stat: p.stat
    }));
    io.to(code).emit('session_ended', { stats, handNum: room.handNum });
    delete rooms[code];
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    const room = getRoom(myRoom);
    if (!room) return;
    const p = room.seats[mySeat];
    if (p) {
      p.connected = false;
      broadcast(room);
      // If it's their turn, auto-fold after 10s
      if (room.queue[0] === mySeat) {
        room.actionTimer = setTimeout(() => {
          applyAction(room, mySeat, 'fold');
          broadcast(room);
          scheduleNext(room);
        }, 10000);
      }
    }
  });                                          

  socket.on('reconnect_room', ({ code, name }) => {
    const room = getRoom(code);
    if (!room) return;
    const p = filledSeats(room).find(p=>p.name===name);
    if (p) {
      p.socketId = socket.id;
      p.connected = true;
      mySeat = p.seatIndex;
      myRoom = code;
      socket.join(code);
      socket.emit('state', buildView(room, socket.id));
    }
  });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log('PokerTrack on port ' + PORT));
}

// Exported for tests / tooling (no effect on normal `node server.js` run).
module.exports = { chenScore, monteCarloEquity, scoreGTO, posLabel, evalBest, cmpE, makeDeck };
