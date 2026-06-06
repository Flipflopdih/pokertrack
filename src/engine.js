// ── Game engine: rooms, dealing, betting, showdown, side pots ──
const { makeDeck, shuffle, evalBest, cmpE } = require('./cards');
const { pfStr, chenScore, posLabel, monteCarloEquity, scoreGTO } = require('./gto');

const rooms = {};
let io = null;
function attach(server_io) { io = server_io; } // wire socket.io in once at startup

function makeCode() { return Math.random().toString(36).substr(2, 6).toUpperCase(); }

function mkStat(startChips) {
  return { startChips, chips: startChips, handsPlayed: 0, handsWon: 0, vpip: 0, folds: 0, ghostWins: 0, luckPts: 0, luckHands: 0, gtoDecisions: [], chipHistory: [startChips], handLog: [] };
}

function createRoom(hostName, hostSocketId, startChips, sb, bb, maxSeats) {
  const code = makeCode();
  rooms[code] = {
    code, hostId: hostSocketId, sb, bb, startChips,
    maxSeats: Math.max(2, Math.min(8, maxSeats || 8)),
    seats: Array(8).fill(null),
    dealer: -1, handNum: 0,
    deck: [], di: 0, pot: 0, board: [],
    curBet: 0, street: '', queue: [],
    over: true, actionTimer: null, phase: 'waiting'
  };
  return code;
}

function getRoom(code) { return rooms[code.toUpperCase()]; }
function deleteRoom(code) { delete rooms[code.toUpperCase()]; }
function filledSeats(room) { return room.seats.filter(Boolean); }
function activePlayers(room) { return room.seats.filter(s => s && !s.folded); }
function seatOfSocket(room, socketId) { return room.seats.findIndex(s => s && s.socketId === socketId); }

function seatPlayer(room, seatIndex, name, socketId, chips) {
  room.seats[seatIndex] = {
    id: socketId, name, socketId, chips, stat: mkStat(chips),
    cards: [], bet: 0, committed: 0, folded: false,
    lastAction: '', seatIndex, curPF: null, connected: true
  };
}

// Move chips into the pot, tracking total commitment for side pots.
function commit(room, p, amt) {
  const pay = Math.min(amt, p.chips);
  p.chips -= pay; p.bet += pay; p.committed += pay; room.pot += pay;
  return pay;
}

function nextSeat(room, fromIdx) {
  for (let i = 1; i <= 8; i++) {
    const idx = (fromIdx + i) % 8;
    if (room.seats[idx]) return idx;
  }
  return fromIdx;
}

function seatView(room, s, i, socketId) {
  return {
    seatIndex: i, id: s.id, name: s.name, chips: s.chips, bet: s.bet,
    folded: s.folded, lastAction: s.lastAction,
    isDealer: i === room.dealer,
    isTurn: !room.over && room.queue[0] === i,
    isYou: socketId != null && s.socketId === socketId,
    cards: socketId != null && s.socketId === socketId ? s.cards : (room.over ? s.cards : s.cards.map(() => null)),
    connected: s.connected
  };
}

function buildView(room, socketId) {
  return {
    code: room.code, handNum: room.handNum, pot: room.pot, board: room.board,
    street: room.street, curBet: room.curBet, over: room.over, phase: room.phase,
    sb: room.sb, bb: room.bb, maxSeats: room.maxSeats, startChips: room.startChips,
    isHost: room.hostId === socketId,
    seats: room.seats.map((s, i) => s ? seatView(room, s, i, socketId) : null)
  };
}

function broadcast(room) {
  filledSeats(room).forEach(p => {
    if (p.socketId) io.to(p.socketId).emit('state', buildView(room, p.socketId));
  });
  io.to(room.code).emit('state_public', buildView(room, null));
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
    if (seat && !seat.folded && seat.chips > 0 && idx !== excludeIdx) q.push(idx);
    idx = nextSeat(room, idx);
    if (idx === startSeatIdx) break;
  }
  return q;
}

function dealHand(room) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
  const players = filledSeats(room);
  if (players.length < 2) { room.phase = 'waiting'; broadcast(room); return; }

  room.handNum++;
  room.phase = 'playing';
  const deck = shuffle(makeDeck());
  room.deck = deck; room.di = 0; room.pot = 0; room.board = [];
  room.curBet = room.bb; room.street = 'preflop'; room.over = false;

  players.forEach(p => {
    p.folded = false; p.cards = []; p.bet = 0; p.committed = 0; p.lastAction = '';
    if (p.chips <= 0) p.chips = room.startChips;
  });

  const filled = room.seats.map((s, i) => s ? i : -1).filter(i => i >= 0);
  if (room.dealer === -1 || filled.indexOf(room.dealer) === -1) room.dealer = filled[0];
  else room.dealer = filled[(filled.indexOf(room.dealer) + 1) % filled.length];

  for (let i = 0; i < 2; i++) players.forEach(p => p.cards.push(deck[room.di++]));

  players.forEach(p => {
    const ps = pfStr(p.cards[0], p.cards[1]);
    p.stat.luckPts += ps.lp; p.stat.luckHands++; p.curPF = ps;
  });

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
  if (!room.queue.length) { advStreet(room); return; }

  const seatIdx = room.queue[0];
  const player = room.seats[seatIdx];
  if (!player) { room.queue.shift(); scheduleNext(room); return; }

  if (!player.connected) {
    room.actionTimer = setTimeout(() => {
      applyAction(room, seatIdx, 'fold'); broadcast(room); scheduleNext(room);
    }, 3000);
  }
  broadcast(room);
}

function applyAction(room, seatIdx, action, raiseAmt) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
  if (room.over) return false;
  if (!room.queue.length || room.queue[0] !== seatIdx) return false;

  const p = room.seats[seatIdx];
  if (!p || p.folded) return false;
  const call = Math.max(0, room.curBet - p.bet);

  if (action === 'fold') {
    p.folded = true; p.lastAction = 'Fold'; p.stat.folds++;
    trackGTO(room, p, 'fold');
  } else if (action === 'check') {
    if (call > 0) return false;
    p.lastAction = 'Check'; p.stat.vpip++;
    trackGTO(room, p, 'check');
  } else if (action === 'call') {
    if (call === 0) return false;
    const pay = commit(room, p, call);
    p.lastAction = pay < call ? 'All-in ' + p.bet : 'Call ' + pay;
    p.stat.vpip++;
    trackGTO(room, p, 'call');
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
    trackGTO(room, p, 'raise');
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
  }

  const res = scoreGTO(ctx);
  const decision = {
    hand: room.handNum, street: room.street, action, position,
    correct: res.correct, note: res.note,
    equity: res.eq != null ? Math.round(res.eq * 100) : null,
    chen: res.chen
  };
  player.stat.gtoDecisions.push(decision);

  // live coaching: privately nudge the player who just acted
  if (player.socketId && io) io.to(player.socketId).emit('gto_feedback', decision);
}

function advStreet(room) {
  filledSeats(room).forEach(p => p.bet = 0);
  room.curBet = 0;

  if (room.street === 'preflop')   { room.board.push(room.deck[room.di++], room.deck[room.di++], room.deck[room.di++]); room.street = 'flop'; }
  else if (room.street === 'flop') { room.board.push(room.deck[room.di++]); room.street = 'turn'; }
  else if (room.street === 'turn') { room.board.push(room.deck[room.di++]); room.street = 'river'; }
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

  filledSeats(room).filter(p => p.folded).forEach(p => {
    if (room.board.length >= 3 && winner && !winner.folded) {
      if (cmpE(evalBest([...p.cards, ...room.board]), evalBest([...winner.cards, ...room.board])) > 0) p.stat.ghostWins++;
    }
  });

  filledSeats(room).forEach(p => {
    p.stat.handsPlayed++;
    p.stat.chips = p.chips;
    p.stat.chipHistory.push(p.chips);
    if (p.curPF) {
      p.stat.handLog.push({
        num: room.handNum, cards: [...p.cards], board: [...room.board],
        pfLabel: p.curPF.label, pfPts: p.curPF.pts,
        won: winnings[p.seatIndex] > 0, folded: p.folded,
        ghostWin: p.folded && room.board.length >= 3 && winner && !winner.folded && cmpE(evalBest([...p.cards, ...room.board]), evalBest([...winner.cards, ...room.board])) > 0,
        winAmt: winnings[p.seatIndex] || 0
      });
    }
  });

  broadcast(room);

  io.to(room.code).emit('hand_over', {
    winnerId: winner.id,
    winnerName: winnerCount > 1 ? 'Split pot' : winner.name,
    pot: room.pot, handName,
    seats: room.seats.map((s, i) => s ? { seatIndex: i, name: s.name, cards: s.cards, folded: s.folded } : null)
  });

  room.actionTimer = setTimeout(() => { if (rooms[room.code]) dealHand(room); }, 4000);
}

module.exports = {
  rooms, attach, createRoom, getRoom, deleteRoom, filledSeats, activePlayers,
  seatPlayer, seatOfSocket, broadcast, buildView, dealHand, applyAction, scheduleNext
};
