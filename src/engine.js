// ── Game engine: rooms, dealing, betting, showdown, side pots ──
const { RV, makeDeck, shuffle, evalBest, cmpE } = require('./cards');
const { pfStr, chenScore, posLabel, monteCarloEquity, scoreGTO, comboLabel, equityVsKnown, showdownEquities } = require('./gto');

const rooms = {};
let io = null;
function attach(server_io) { io = server_io; } // wire socket.io in once at startup

function makeCode() { return Math.random().toString(36).substr(2, 6).toUpperCase(); }

function mkStat(startChips) {
  return {
    startChips, chips: startChips, handsPlayed: 0, handsWon: 0, vpip: 0, folds: 0, ghostWins: 0,
    luckNum: 0, luckDen: 0, luckChips: 0, // showdown-only realized-equity luck (not affected by bluffs)
    bluffs: 0, bluffsWon: 0,              // low-equity bets/raises and how many got through
    gtoDecisions: [], chipHistory: [startChips], handLog: []
  };
}

function createRoom(hostName, hostSocketId, startChips, sb, bb, maxSeats, blindUpMin, turnSec) {
  const code = makeCode();
  rooms[code] = {
    code, hostId: hostSocketId, sb, bb, startChips,
    maxSeats: Math.max(2, Math.min(8, maxSeats || 8)),
    seats: Array(8).fill(null),
    dealer: -1, handNum: 0,
    deck: [], di: 0, pot: 0, board: [],
    curBet: 0, street: '', queue: [],
    over: true, actionTimer: null, phase: 'waiting',
    blindUpMs: Math.max(0, (blindUpMin || 0) * 60000), level: 1, nextBlindAt: 0, blindTimer: null,
    turnMs: turnSec === 0 ? 0 : Math.max(8, Math.min(120, turnSec || 30)) * 1000, // per-turn time limit (0 = off)
    turnDeadline: 0, paused: false
  };
  return code;
}

// Tournament blind levels: double the blinds every `blindUpMs` once the game starts.
function startBlindTimer(room) {
  if (!room.blindUpMs || room.blindTimer) return;
  room.nextBlindAt = Date.now() + room.blindUpMs;
  room.blindTimer = setInterval(() => {
    if (!rooms[room.code]) return stopBlindTimer(room);
    room.level++; room.sb *= 2; room.bb *= 2;
    room.nextBlindAt = Date.now() + room.blindUpMs;
    io.to(room.code).emit('blinds_up', { level: room.level, sb: room.sb, bb: room.bb });
    broadcast(room);
  }, room.blindUpMs);
}
function stopBlindTimer(room) { if (room.blindTimer) { clearInterval(room.blindTimer); room.blindTimer = null; } }

function getRoom(code) { return rooms[code.toUpperCase()]; }
function deleteRoom(code) { delete rooms[code.toUpperCase()]; }
function filledSeats(room) { return room.seats.filter(Boolean); }
function activePlayers(room) { return room.seats.filter(s => s && !s.folded); }
function seatOfSocket(room, socketId) { return room.seats.findIndex(s => s && s.socketId === socketId); }

function seatPlayer(room, seatIndex, name, socketId, chips, playerId) {
  room.seats[seatIndex] = {
    id: socketId, name, socketId, playerId: playerId || socketId, chips, stat: mkStat(chips),
    cards: [], bet: 0, committed: 0, folded: false,
    lastAction: '', seatIndex, curPF: null, connected: true,
    sawFlop: false, pfAction: null, sittingOut: false, showCards: false, rigged: false
  };
}
function seatByPlayer(room, playerId) { return room.seats.find(s => s && s.playerId === playerId); }
function anyConnected(room) { return room.seats.some(s => s && s.connected); }

// Move chips into the pot, tracking total commitment for side pots.
function commit(room, p, amt) {
  const pay = Math.min(amt, p.chips);
  p.chips -= pay; p.bet += pay; p.committed += pay; room.pot += pay;
  return pay;
}

function nextSeat(room, fromIdx) {
  for (let i = 1; i <= 8; i++) {
    const idx = (fromIdx + i) % 8;
    const s = room.seats[idx];
    if (s && !s.sittingOut) return idx; // sitting-out seats are skipped in the action order
  }
  return fromIdx;
}

const RANK_NAME = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: 'Ten', 9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two' };
function madeHandLabel(cards, board) {
  if (!cards || cards.length < 2 || !cards[0]) return '';
  if (board.length >= 3) return evalBest([...cards, ...board]).name;
  if (cards[0].r === cards[1].r) return 'Pair of ' + RANK_NAME[cards[0].r] + 's';
  const hi = RV[cards[0].r] >= RV[cards[1].r] ? cards[0].r : cards[1].r;
  return RANK_NAME[hi] + ' high';
}

function seatView(room, s, i, socketId) {
  const mine = socketId != null && s.socketId === socketId;
  // At showdown, opponents' cards are only visible if that player chose to show (or won).
  const cards = mine ? s.cards : (room.over && s.showCards ? s.cards : s.cards.map(() => null));
  return {
    seatIndex: i, id: s.id, name: s.name, chips: s.chips, bet: s.bet,
    folded: s.folded, lastAction: s.lastAction, wins: s.stat.handsWon,
    sittingOut: s.sittingOut, showCards: s.showCards,
    isDealer: i === room.dealer,
    isTurn: !room.over && !room.paused && room.queue[0] === i,
    isYou: mine, cards, connected: s.connected
  };
}

function buildView(room, socketId) {
  const me = socketId != null ? room.seats.find(s => s && s.socketId === socketId) : null;
  return {
    code: room.code, handNum: room.handNum, pot: room.pot, board: room.board,
    street: room.street, curBet: room.curBet, over: room.over, phase: room.phase,
    sb: room.sb, bb: room.bb, maxSeats: room.maxSeats, startChips: room.startChips,
    level: room.level, nextBlindAt: room.nextBlindAt, blindUpMs: room.blindUpMs,
    turnMs: room.turnMs, turnDeadline: room.over ? 0 : room.turnDeadline,
    isHost: room.hostId === socketId,
    rig: room.hostId === socketId ? room.seats.map((s, i) => s && s.rigged ? i : -1).filter(i => i >= 0) : null,
    myHand: me && room.phase === 'playing' ? madeHandLabel(me.cards, room.board) : '',
    seats: room.seats.map((s, i) => s ? seatView(room, s, i, socketId) : null)
  };
}

function broadcast(room) {
  // send each socket in the room its own personalized view (seated, unseated, or spectating)
  const ids = io.sockets.adapter.rooms.get(room.code);
  if (ids) for (const sid of ids) io.to(sid).emit('state', buildView(room, sid));
}

function bettingClosed(room) { return activePlayers(room).filter(p => p.chips > 0).length <= 1; }
function sfx(room, name) { if (io) io.to(room.code).emit('sfx', name); } // broadcast a sound cue to everyone

// Broadcast live win% for everyone still in (used during all-in run-outs).
function emitEquities(room) {
  const act = activePlayers(room);
  if (act.length < 2) return;
  io.to(room.code).emit('equities', showdownEquities(act.map(p => ({ seatIndex: p.seatIndex, cards: p.cards })), room.board, 400));
}

function postBlind(room, seatIdx, amt) {
  const p = room.seats[seatIdx];
  if (!p) return;
  p.lastAction = 'Blind ' + commit(room, p, amt);
}

// Ordered seats that still need to act (skips folded, all-in, and the aggressor).
function buildQueue(room, startSeatIdx, excludeIdx) {
  const q = [];
  let idx = startSeatIdx;
  for (let i = 0; i < 8; i++) {
    const seat = room.seats[idx];
    if (seat && !seat.folded && !seat.sittingOut && seat.chips > 0 && idx !== excludeIdx) q.push(idx);
    idx = nextSeat(room, idx);
    if (idx === startSeatIdx) break;
  }
  return q;
}

function dealHand(room) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
  const players = filledSeats(room).filter(p => !p.sittingOut); // sitting-out players aren't dealt in
  if (players.length < 2) { room.phase = 'waiting'; room.over = true; broadcast(room); return; }

  room.handNum++;
  room.phase = 'playing';
  const deck = shuffle(makeDeck());
  room.deck = deck; room.di = 0; room.pot = 0; room.board = [];
  room.curBet = room.bb; room.street = 'preflop'; room.over = false;

  players.forEach(p => {
    p.folded = false; p.cards = []; p.bet = 0; p.committed = 0; p.lastAction = '';
    p.sawFlop = false; p.pfAction = null; p.showCards = false; p.bluffedThisHand = false;
    if (p.chips <= 0) p.chips = room.startChips;
  });
  // sitting-out players sit the hand out (excluded from action/showdown)
  filledSeats(room).filter(p => p.sittingOut).forEach(p => {
    p.folded = true; p.cards = []; p.bet = 0; p.committed = 0; p.lastAction = 'Sitting out'; p.curPF = null; p.showCards = false;
  });

  const filled = room.seats.map((s, i) => (s && !s.sittingOut) ? i : -1).filter(i => i >= 0);
  if (room.dealer === -1 || filled.indexOf(room.dealer) === -1) room.dealer = filled[0];
  else room.dealer = filled[(filled.indexOf(room.dealer) + 1) % filled.length];

  for (let i = 0; i < 2; i++) players.forEach(p => p.cards.push(deck[room.di++]));
  sfx(room, 'deal');

  players.forEach(p => { p.curPF = pfStr(p.cards[0], p.cards[1]); });

  // Heads-up: the dealer is the small blind and acts first preflop.
  let sbIdx, bbIdx, startIdx;
  if (players.length === 2) {
    sbIdx = room.dealer; bbIdx = nextSeat(room, room.dealer); startIdx = sbIdx;
  } else {
    sbIdx = nextSeat(room, room.dealer); bbIdx = nextSeat(room, sbIdx); startIdx = nextSeat(room, bbIdx);
  }
  postBlind(room, sbIdx, room.sb);
  postBlind(room, bbIdx, room.bb);
  room.queue = buildQueue(room, startIdx);

  broadcast(room);
  scheduleNext(room);
}

function scheduleNext(room) {
  if (room.over) return;
  if (activePlayers(room).length <= 1) { endHand(room); return; }
  if (!room.queue.length) {
    if (bettingClosed(room)) emitEquities(room); // all-in run-out: show live equities
    advStreet(room); return;
  }

  const seatIdx = room.queue[0];
  const player = room.seats[seatIdx];
  if (!player) { room.queue.shift(); scheduleNext(room); return; }

  // auto-act on timeout: disconnected players fold fast; connected players get the turn clock
  const timeoutMs = !player.connected ? 3000 : room.turnMs;
  if (timeoutMs) {
    room.turnDeadline = Date.now() + timeoutMs;
    room.actionTimer = setTimeout(() => {
      const call = Math.max(0, room.curBet - player.bet);
      // only advance if the action actually applied — guards against stale timers cascading
      if (applyAction(room, seatIdx, call > 0 ? 'fold' : 'check')) afterAction(room, 450);
    }, timeoutMs);
  } else {
    room.turnDeadline = 0;
  }
  broadcast(room);
}

// A short, watchable beat after an action before the next player can act.
function afterAction(room, ms) {
  if (room.over) { broadcast(room); return; }
  room.paused = true;
  broadcast(room);
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
  room.actionTimer = setTimeout(() => {
    if (!rooms[room.code]) return;
    room.paused = false;
    scheduleNext(room);
  }, ms);
}

function applyAction(room, seatIdx, action, raiseAmt) {
  if (room.paused) return false; // brief beat between actions — checked before touching the timer
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
  if (room.over) return false;
  if (!room.queue.length || room.queue[0] !== seatIdx) return false;

  const p = room.seats[seatIdx];
  if (!p || p.folded) return false;
  const call = Math.max(0, room.curBet - p.bet);

  if (action === 'fold') {
    p.folded = true; p.lastAction = 'Fold'; p.stat.folds++;
    trackGTO(room, p, 'fold'); sfx(room, 'fold');
  } else if (action === 'check') {
    if (call > 0) return false;
    p.lastAction = 'Check'; p.stat.vpip++;
    trackGTO(room, p, 'check'); sfx(room, 'check');
  } else if (action === 'call') {
    if (call === 0) return false;
    const pay = commit(room, p, call);
    p.lastAction = pay < call ? 'All-in ' + p.bet : 'Call ' + pay;
    p.stat.vpip++;
    trackGTO(room, p, 'call'); sfx(room, pay < call ? 'allin' : 'call');
  } else if (action === 'raise') {
    if (p.chips <= call) return false;
    const minRaise = room.curBet + room.bb;
    const target = Math.max(raiseAmt || 0, minRaise);
    const extra = Math.min(target - p.bet, p.chips);
    if (extra <= 0) return false;
    commit(room, p, extra);
    room.curBet = p.bet;
    p.lastAction = (p.chips === 0 ? 'All-in ' : 'Raise ') + p.bet;
    p.stat.vpip++;
    trackGTO(room, p, 'raise'); sfx(room, p.chips === 0 ? 'allin' : 'raise');
    room.queue = buildQueue(room, nextSeat(room, seatIdx), seatIdx);
    return true;
  } else if (action === 'allin') {
    if (p.chips <= 0) return false;
    const wasRaise = (p.bet + p.chips) > room.curBet;
    commit(room, p, p.chips);
    p.lastAction = 'All-in ' + p.bet;
    p.stat.vpip++;
    trackGTO(room, p, wasRaise ? 'raise' : 'call'); sfx(room, 'allin');
    if (wasRaise) {
      room.curBet = p.bet;
      room.queue = buildQueue(room, nextSeat(room, seatIdx), seatIdx);
      return true;
    }
  }

  room.queue.shift();
  return true;
}

function trackGTO(room, player, action) {
  const callAmt = Math.max(0, room.curBet - player.bet);
  const potOdds = room.pot > 0 ? callAmt / (room.pot + callAmt) : 0;

  const filled = room.seats.map((s, i) => s ? i : -1).filter(i => i >= 0);
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
    // a "bluff": a postflop bet/raise with weak equity
    if ((action === 'raise') && ctx.equity < 0.33) { player.stat.bluffs++; player.bluffedThisHand = true; }
  }

  // remember the player's strongest preflop action (for the range grid)
  if (room.street === 'preflop') {
    const prec = { fold: 0, check: 1, call: 2, raise: 3 };
    if (player.pfAction == null || prec[action] > prec[player.pfAction]) player.pfAction = action;
  }

  const res = scoreGTO(ctx);
  player.stat.gtoDecisions.push({
    hand: room.handNum, street: room.street, action, position,
    correct: res.correct, note: res.note,
    equity: res.eq != null ? Math.round(res.eq * 100) : null,
    chen: res.chen
  });
}

// Host "🎲 Luck mode": the two unused cards that make the strongest hand on this board.
function bestHoleForBoard(board, pool) {
  let best = null, pick = null;
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    const ev = evalBest([pool[i], pool[j], ...board]);
    if (!best || cmpE(ev, best) > 0) { best = ev; pick = [pool[i], pool[j]]; }
  }
  return pick;
}
// On the river, swap each rigged (still-in) player's hole cards to a monster, no collisions.
function applyRig(room) {
  const rigged = activePlayers(room).filter(p => p.rigged);
  if (!rigged.length) return;
  const used = new Set(room.board.map(c => c.r + c.s));
  activePlayers(room).filter(p => !p.rigged).forEach(p => p.cards.forEach(c => used.add(c.r + c.s)));
  rigged.forEach(p => {
    const pool = makeDeck().filter(c => !used.has(c.r + c.s));
    const pick = bestHoleForBoard(room.board, pool);
    if (pick) { p.cards = pick; p.curPF = pfStr(pick[0], pick[1]); pick.forEach(c => used.add(c.r + c.s)); }
  });
}

function advStreet(room) {
  filledSeats(room).forEach(p => p.bet = 0);
  room.curBet = 0;

  if (room.street === 'preflop')   { room.board.push(room.deck[room.di++], room.deck[room.di++], room.deck[room.di++]); room.street = 'flop'; filledSeats(room).forEach(p => { if (!p.folded) p.sawFlop = true; }); }
  else if (room.street === 'flop') { room.board.push(room.deck[room.di++]); room.street = 'turn'; }
  else if (room.street === 'turn') { room.board.push(room.deck[room.di++]); room.street = 'river'; applyRig(room); }
  else { endHand(room); return; }

  room.queue = buildQueue(room, nextSeat(room, room.dealer));
  broadcast(room);
  setTimeout(() => scheduleNext(room), 600);
}

// Layered side pots from each player's total commitment.
function settlePots(room) {
  const winnings = {};
  filledSeats(room).forEach(p => winnings[p.seatIndex] = 0);

  let contrib = filledSeats(room).map(p => ({ p, amt: p.committed })).filter(c => c.amt > 0);
  const layers = [];
  while (contrib.length) {
    const lvl = Math.min(...contrib.map(c => c.amt));
    let amount = 0;
    contrib.forEach(c => { amount += lvl; c.amt -= lvl; });
    layers.push({ amount, eligible: contrib.filter(c => !c.p.folded).map(c => c.p) });
    contrib = contrib.filter(c => c.amt > 0);
  }

  layers.forEach(layer => {
    if (!layer.amount || !layer.eligible.length) return;
    let recipients = layer.eligible;
    if (recipients.length > 1) {
      const evals = recipients.map(p => ({ p, ev: evalBest([...p.cards, ...room.board]) }));
      evals.sort((a, b) => cmpE(b.ev, a.ev));
      const best = evals[0].ev;
      recipients = evals.filter(e => cmpE(e.ev, best) === 0).map(e => e.p);
    }
    const share = Math.floor(layer.amount / recipients.length);
    const rem = layer.amount - share * recipients.length;
    recipients.forEach(w => { w.chips += share; winnings[w.seatIndex] += share; });
    if (rem > 0) { recipients[0].chips += rem; winnings[recipients[0].seatIndex] += rem; }
  });

  return { winnings };
}

function endHand(room) {
  room.over = true;
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }

  const active = activePlayers(room);
  const showdown = active.length > 1 && room.board.length === 5;
  const { winnings } = settlePots(room);

  let winner = null, best = -1;
  filledSeats(room).forEach(p => { if (winnings[p.seatIndex] > best) { best = winnings[p.seatIndex]; winner = p; } });
  if (!winner) winner = active[0] || filledSeats(room)[0];

  const winnerCount = filledSeats(room).filter(p => winnings[p.seatIndex] > 0).length;
  let handName = '';
  if (showdown && !winner.folded) { handName = evalBest([...winner.cards, ...room.board]).name; winner.lastAction = handName; }
  filledSeats(room).forEach(p => { if (winnings[p.seatIndex] > 0) p.stat.handsWon++; });
  // at showdown the winner(s) must show; everyone else may show/muck during the break
  if (showdown) filledSeats(room).forEach(p => { if (winnings[p.seatIndex] > 0) p.showCards = true; });

  filledSeats(room).filter(p => p.folded).forEach(p => {
    if (room.board.length >= 3 && winner && !winner.folded) {
      if (cmpE(evalBest([...p.cards, ...room.board]), evalBest([...winner.cards, ...room.board])) > 0) p.stat.ghostWins++;
    }
  });

  // "Run-good" luck — ONLY from showdown pots, so a successful bluff (winning a
  // pot you were behind in) counts as skill, not luck. Pot-weighted.
  const flop = room.board.slice(0, 3);
  const wentToShowdown = active.length > 1 && room.board.length === 5;
  const uncontested = active.length === 1; // everyone folded → a bluff/steal got through

  filledSeats(room).forEach(p => {
    p.stat.handsPlayed++;
    p.stat.chips = p.chips;
    p.stat.chipHistory.push(p.chips);
    // bluff success: a low-equity bet/raise this hand that won the pot uncontested
    if (p.bluffedThisHand && uncontested && winnings[p.seatIndex] > 0) p.stat.bluffsWon++;
    if (!p.curPF) return;

    let perHand = null, weight, realizedChips = 0;
    if (wentToShowdown && !p.folded) {
      // pure card luck: did your hand run above/below its flop equity vs the showdown field?
      const opps = active.filter(o => o !== p);
      const eq = equityVsKnown(p.cards, flop, opps.map(o => o.cards), 200) ?? 0;
      realizedChips = (winnings[p.seatIndex] || 0) - eq * room.pot;
      perHand = room.pot ? Math.max(-1, Math.min(1, realizedChips / room.pot)) : 0;
      weight = room.bb ? room.pot / room.bb : 1;
    } else if (!p.sawFlop) {
      // hands that didn't reach a flop: just the card-dealing luck (very light weight)
      const cp = Math.max(0, Math.min(1, (chenScore(p.cards[0], p.cards[1]) + 2) / 22));
      perHand = (cp - 0.5) * 0.5;
      weight = 0.5;
    }
    if (perHand !== null) {
      p.stat.luckNum += perHand * weight;
      p.stat.luckDen += weight;
      p.stat.luckChips += realizedChips;
    }

    p.stat.handLog.push({
      num: room.handNum, cards: [...p.cards], board: [...room.board],
      pfLabel: p.curPF.label, pfPts: p.curPF.pts,
      combo: comboLabel(p.cards[0], p.cards[1]),
      pfAction: p.pfAction || (p.folded ? 'fold' : 'check'),
      luckPct: perHand !== null ? Math.round((perHand + 1) / 2 * 100) : 50,
      won: winnings[p.seatIndex] > 0, folded: p.folded,
      ghostWin: p.folded && room.board.length >= 3 && winner && !winner.folded && cmpE(evalBest([...p.cards, ...room.board]), evalBest([...winner.cards, ...room.board])) > 0,
      winAmt: winnings[p.seatIndex] || 0
    });
  });

  broadcast(room);

  // can this player still choose to show? (was in the hand, didn't win, hasn't shown)
  const canShow = p => showdown && !p.folded && !p.showCards && winnings[p.seatIndex] === 0;
  io.to(room.code).emit('hand_over', {
    winnerId: winner.id,
    winnerName: winnerCount > 1 ? 'Split pot' : winner.name,
    pot: room.pot, handName,
    seats: room.seats.map((s, i) => s ? { seatIndex: i, name: s.name, cards: s.showCards ? s.cards : s.cards.map(() => null), folded: s.folded, canShow: canShow(s) } : null)
  });

  room.actionTimer = setTimeout(() => { if (rooms[room.code]) dealHand(room); }, 5000);
}

// A player chooses to show their mucked hand during the showdown break.
function showCardsAction(room, socketId) {
  const idx = seatOfSocket(room, socketId);
  if (idx < 0 || !room.over) return;
  const p = room.seats[idx];
  if (p && !p.folded && p.cards.length) { p.showCards = true; broadcast(room); }
}

module.exports = {
  rooms, attach, createRoom, getRoom, deleteRoom, filledSeats, activePlayers,
  seatPlayer, seatOfSocket, broadcast, buildView, dealHand, applyAction, scheduleNext,
  startBlindTimer, stopBlindTimer, showCardsAction, afterAction, seatByPlayer, anyConnected
};
