const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── ROOM STORAGE ───
const rooms = {}; // roomCode -> Room

function makeCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// ─── CARD ENGINE ───
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['s','h','d','c']; // spades hearts diamonds clubs
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

// ─── HAND EVALUATOR ───
function evalBest(cards) {
  if (cards.length === 5) return eval5(cards);
  let best = null;
  for (const c of combos(cards, 5)) {
    const e = eval5(c);
    if (!best || cmpE(e, best) > 0) best = e;
  }
  return best;
}
function combos(arr, k) {
  if (!k) return [[]];
  if (arr.length === k) return [arr];
  const [f, ...r] = arr;
  return [...combos(r, k - 1).map(c => [f, ...c]), ...combos(r, k)];
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
  if (fl && st) { rank = 8; name = vs[0] === 14 && vs[1] === 13 ? 'Royal Flush' : 'Straight Flush'; }
  else if (g[0] === 4) { rank = 7; name = 'Four of a Kind'; }
  else if (g[0] === 3 && g[1] === 2) { rank = 6; name = 'Full House'; }
  else if (fl) { rank = 5; name = 'Flush'; }
  else if (st) { rank = 4; name = 'Straight'; }
  else if (g[0] === 3) { rank = 3; name = 'Three of a Kind'; }
  else if (g[0] === 2 && g[1] === 2) { rank = 2; name = 'Two Pair'; }
  else if (g[0] === 2) { rank = 1; name = 'One Pair'; }
  else { rank = 0; name = 'High Card'; }
  return { rank, name, vs };
}
function isStraight(vs) {
  const u = [...new Set(vs)];
  if (u.length < 5) return false;
  if (u[0] === 14 && u[1] === 5 && u[2] === 4 && u[3] === 3 && u[4] === 2) return true;
  return u[0] - u[4] === 4;
}
function cmpE(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < a.vs.length; i++) if (a.vs[i] !== b.vs[i]) return a.vs[i] - b.vs[i];
  return 0;
}

// ─── PREFLOP STRENGTH ───
function pfStrength(c1, c2) {
  const v1 = RV[c1.r], v2 = RV[c2.r];
  const hi = Math.max(v1, v2), lo = Math.min(v1, v2);
  const suited = c1.s === c2.s, pair = c1.r === c2.r;
  let pts = 0, label = '', premium = false;
  if (pair) {
    pts = hi >= 13 ? 10 : hi >= 11 ? 9 : hi >= 9 ? 7 : hi >= 7 ? 5 : 3;
    label = hi >= 13 ? 'Premium pair' : hi >= 10 ? 'Strong pair' : 'Pocket pair';
    premium = hi >= 11;
  } else {
    pts = (hi === 14 ? 6 : hi === 13 ? 5 : hi === 12 ? 4 : hi >= 10 ? 3 : 2)
      + (lo >= 12 ? 2 : lo >= 10 ? 1 : 0)
      + (suited ? 2 : 0) + (hi - lo <= 1 ? 1 : 0);
    label = hi === 14 && lo >= 13 ? 'Ace-King'
      : hi === 14 ? 'Ace-high'
      : suited && hi - lo <= 2 && hi >= 10 ? 'Suited connector'
      : hi >= 12 ? 'Strong offsuit'
      : suited ? 'Suited hand' : 'Speculative';
    premium = (hi === 14 && lo >= 11) || (suited && hi - lo <= 1 && hi >= 11);
  }
  return { pts, label, premium, lp: premium ? 3 : pts >= 6 ? 2 : pts >= 4 ? 1 : 0 };
}

// ─── GTO ACCURACY (simplified positional ranges) ───
// Based on standard GTO opening ranges by position
const GTO_OPEN_RANGES = {
  BTN: 45, // open 45% of hands from button
  CO:  30,
  MP:  20,
  UTG: 14,
  SB:  40,
  BB:  0   // BB never opens preflop
};

function gtoScore(action, pfPts, position, street, boardStrength, potOdds) {
  let correct = null;
  let note = '';

  if (street === 'preflop') {
    // Map pts (0-10) to rough open percentage
    // Top 14% = pts>=7, top 20% = pts>=6, top 30% = pts>=5, top 45% = pts>=4
    const threshold = position === 'BTN' || position === 'SB' ? 4
      : position === 'CO' ? 5
      : position === 'MP' ? 6 : 7;

    if (action === 'fold') {
      correct = pfPts < threshold;
      note = correct ? 'Correct fold — hand below position range'
        : 'Should have opened — hand is in your positional range';
    } else {
      correct = pfPts >= threshold;
      note = correct ? 'Correct — hand is in your positional range'
        : 'Marginal — hand is below standard opening range for this position';
    }
  } else {
    // Postflop: use board strength (0-8 hand rank)
    if (action === 'fold') {
      correct = boardStrength < 2 && potOdds < 0.25;
      note = correct ? 'Correct fold — weak hand, bad pot odds'
        : boardStrength >= 3 ? 'Should have continued — strong hand'
        : 'Borderline — consider pot odds next time';
    } else if (action === 'raise') {
      correct = boardStrength >= 4;
      note = correct ? 'Good aggression — strong hand warrants a raise'
        : 'Thin raise — GTO prefers check/call with this hand strength';
    } else {
      correct = boardStrength >= 1 || potOdds > 0.3;
      note = correct ? 'Reasonable continue'
        : 'GTO leans towards folding here — weak hand, poor odds';
    }
  }

  return { correct, note, pts: correct ? 100 : 0 };
}

// ─── SLUMBOT API (heads-up GTO) ───
// Slumbot uses a specific card notation: rank+suit e.g. "Ah" "Kd"
function toSlumbot(card) {
  return card.r === 'T' ? '10' + card.s : card.r.toLowerCase() + card.s;
}

async function querySlumbot(holeCards, board, action, pot, toCall) {
  try {
    // Slumbot API: https://slumbot.com/api/
    const hand = holeCards.map(toSlumbot).join('');
    const boardStr = board.map(toSlumbot).join('');
    const url = `https://slumbot.com/api/holdem?hole_cards=${hand}&board=${boardStr}&pot=${pot}&to_call=${toCall}&action=${action}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data; // { recommended_action, ev, fold_freq, call_freq, raise_freq }
  } catch {
    return null; // API unavailable, fall back to simplified scorer
  }
}

// ─── MAKE STAT OBJECT ───
function mkStat(startChips) {
  return {
    startChips, chips: startChips,
    handsPlayed: 0, handsWon: 0,
    vpip: 0, folds: 0, ghostWins: 0,
    luckPts: 0, luckHands: 0,
    gtoDecisions: [], // { street, action, correct, note, slumbot }
    chipHistory: [startChips],
    handLog: []
  };
}

// ─── ROOM & GAME LOGIC ───
function createRoom(hostName, startChips, bb, sb, maxPlayers) {
  const code = makeCode();
  rooms[code] = {
    code,
    players: [], // { id, name, chips, stat, socketId, ready, folded, cards, bet, isAI }
    maxPlayers,
    startChips, bb, sb,
    dealer: 0, handNum: 0,
    deck: [], di: 0,
    pot: 0, board: [],
    curBet: 0, street: '',
    queue: [], over: true,
    actionTimeout: null
  };
  return code;
}

function getRoom(code) { return rooms[code]; }

function addPlayer(room, name, socketId, isAI = false) {
  const id = isAI ? 'ai_' + room.players.length : socketId;
  room.players.push({
    id, name, socketId,
    chips: room.startChips,
    stat: mkStat(room.startChips),
    ready: false, folded: false,
    cards: [], bet: 0, isAI
  });
}

function broadcastRoom(room) {
  // Send each player their own private view
  room.players.forEach(p => {
    if (!p.socketId || p.isAI) return;
    const view = buildView(room, p.id);
    io.to(p.socketId).emit('game_state', view);
  });
}

function buildView(room, playerId) {
  return {
    roomCode: room.code,
    handNum: room.handNum,
    pot: room.pot,
    board: room.board,
    street: room.street,
    curBet: room.curBet,
    over: room.over,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      isAI: p.isAI,
      isYou: p.id === playerId,
      cards: p.id === playerId ? p.cards : (room.over ? p.cards : p.cards.map(() => null)),
      action: p.lastAction || '',
      isDealer: room.players.indexOf(p) === room.dealer % room.players.length,
      isTurn: !room.over && room.queue[0] === p.id
    }))
  };
}

function dealHand(room) {
  if (room.actionTimeout) { clearTimeout(room.actionTimeout); room.actionTimeout = null; }
  room.handNum++;
  const deck = shuffle(makeDeck());
  room.deck = deck; room.di = 0; room.pot = 0; room.board = [];
  room.curBet = room.bb; room.street = 'preflop'; room.over = false;
  room.players.forEach(p => {
    p.folded = false; p.cards = []; p.bet = 0; p.lastAction = '';
    if (p.chips < room.bb) p.chips = room.startChips;
  });
  room.dealer = (room.dealer + 1) % room.players.length;
  // deal 2 each
  for (let i = 0; i < 2; i++) room.players.forEach(p => p.cards.push(deck[room.di++]));
  // preflop luck tracking
  room.players.forEach(p => {
    const ps = pfStrength(p.cards[0], p.cards[1]);
    p.stat.luckPts += ps.lp;
    p.stat.luckHands++;
    p.curPF = ps;
  });
  // post blinds
  const n = room.players.length;
  const sbIdx = (room.dealer + 1) % n;
  const bbIdx = (room.dealer + 2) % n;
  postBlind(room, sbIdx, room.sb);
  postBlind(room, bbIdx, room.bb);
  room.queue = buildQueue(room, 'preflop');
  broadcastRoom(room);
  tickRoom(room);
}

function postBlind(room, idx, amt) {
  const p = room.players[idx];
  const pay = Math.min(amt, p.chips);
  p.chips -= pay; p.bet += pay; room.pot += pay;
  p.lastAction = 'Blind ' + pay;
}

function buildQueue(room, street) {
  const n = room.players.length;
  const start = street === 'preflop'
    ? (room.dealer + 3) % n
    : (room.dealer + 1) % n;
  const q = [];
  for (let i = 0; i < n; i++) {
    const p = room.players[(start + i) % n];
    if (!p.folded) q.push(p.id);
  }
  return q;
}

function activeCount(room) { return room.players.filter(p => !p.folded).length; }

function tickRoom(room) {
  if (room.over) return;
  if (activeCount(room) === 1) { endHand(room); return; }
  if (!room.queue.length) { advStreet(room); return; }

  const pid = room.queue[0];
  const player = room.players.find(p => p.id === pid);
  if (!player) { room.queue.shift(); tickRoom(room); return; }

  if (player.isAI) {
    // AI acts after delay
    room.actionTimeout = setTimeout(() => {
      aiAct(room, player);
      room.queue.shift();
      broadcastRoom(room);
      tickRoom(room);
    }, 800 + Math.random() * 600);
  } else {
    // Wait for player action via socket
    // Set a 30s timeout in case player disconnects
    room.actionTimeout = setTimeout(() => {
      applyAction(room, pid, 'fold');
    }, 30000);
    broadcastRoom(room);
  }
}

function aiAct(room, ai) {
  const call = Math.max(0, room.curBet - ai.bet);
  const pf = pfStrength(ai.cards[0], ai.cards[1]);
  const hs = room.board.length >= 3 ? evalBest([...ai.cards, ...room.board]) : null;
  const score = hs ? hs.rank * 2 + pf.pts * 0.5 : pf.pts;
  const bluff = Math.random();
  let action, amount = 0;

  if (call === 0) {
    if (score >= 7 || bluff < 0.28) {
      amount = Math.min(ai.chips + ai.bet, ai.bet + Math.max(room.bb * 2, 0 | room.pot * 0.5));
      action = 'raise';
    } else { action = 'check'; }
  } else if (score >= 5 || (score >= 3 && bluff < 0.5) || bluff < 0.12) {
    if (score >= 7 && bluff < 0.35) {
      amount = Math.min(ai.chips + ai.bet, Math.max(room.curBet * 2, ai.bet + 0 | room.pot * 0.7));
      action = 'raise';
    } else { action = 'call'; }
  } else { action = 'fold'; }

  applyAction(room, ai.id, action, amount, true);
}

function applyAction(room, playerId, action, raiseAmount = 0, isAI = false) {
  if (room.actionTimeout) { clearTimeout(room.actionTimeout); room.actionTimeout = null; }
  const p = room.players.find(x => x.id === playerId);
  if (!p || p.folded) return;

  const call = Math.max(0, room.curBet - p.bet);

  if (action === 'fold') {
    p.folded = true;
    p.lastAction = 'Fold';
    if (!isAI) { p.stat.folds++; trackGTO(room, p, 'fold'); }
  } else if (action === 'check') {
    p.lastAction = 'Check';
    if (!isAI) { p.stat.vpip++; trackGTO(room, p, 'check'); }
  } else if (action === 'call') {
    const pay = Math.min(call, p.chips);
    p.chips -= pay; p.bet += pay; room.pot += pay;
    p.lastAction = 'Call ' + pay;
    if (!isAI) { p.stat.vpip++; trackGTO(room, p, 'call'); }
  } else if (action === 'raise') {
    const target = raiseAmount || Math.max(room.curBet * 2, room.bb * 2);
    const extra = Math.min(target - p.bet, p.chips);
    p.chips -= extra; p.bet += extra; room.pot += extra;
    room.curBet = Math.max(room.curBet, p.bet);
    p.lastAction = 'Raise ' + p.bet;
    if (!isAI) { p.stat.vpip++; trackGTO(room, p, 'raise'); }
  }

  // Remove acted player from queue
  room.queue = room.queue.filter(id => id !== playerId);
}

function trackGTO(room, player, action) {
  const boardStr = room.board.length >= 3 ? evalBest([...player.cards, ...room.board]) : null;
  const boardStrength = boardStr ? boardStr.rank : 0;
  const potOdds = room.pot > 0 ? (room.curBet - player.bet) / (room.pot + room.curBet) : 0;
  const positions = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
  const posIdx = (room.players.indexOf(player) - room.dealer + room.players.length) % room.players.length;
  const position = positions[Math.min(posIdx, positions.length - 1)];

  const result = gtoScore(action, player.curPF ? player.curPF.pts : 0, position, room.street, boardStrength, potOdds);
  player.stat.gtoDecisions.push({
    hand: room.handNum,
    street: room.street,
    action,
    position,
    correct: result.correct,
    note: result.note
  });
}

function advStreet(room) {
  room.players.forEach(p => p.bet = 0);
  room.curBet = 0;
  if (room.street === 'preflop') { room.board.push(room.deck[room.di++], room.deck[room.di++], room.deck[room.di++]); room.street = 'flop'; }
  else if (room.street === 'flop') { room.board.push(room.deck[room.di++]); room.street = 'turn'; }
  else if (room.street === 'turn') { room.board.push(room.deck[room.di++]); room.street = 'river'; }
  else { endHand(room); return; }
  room.queue = buildQueue(room, room.street);
  broadcastRoom(room);
  setTimeout(() => tickRoom(room), 400);
}

function endHand(room) {
  room.over = true;
  if (room.actionTimeout) { clearTimeout(room.actionTimeout); room.actionTimeout = null; }

  const active = room.players.filter(p => !p.folded);
  let winner = null;

  if (active.length === 1) {
    winner = active[0];
  } else {
    // Showdown
    const hands = active.map(p => ({ p, ev: evalBest([...p.cards, ...room.board]) }));
    hands.sort((a, b) => cmpE(b.ev, a.ev));
    winner = hands[0].p;
  }

  winner.chips += room.pot;
  winner.stat.handsWon++;

  // Ghost win check for folded human players
  room.players.filter(p => p.folded && !p.isAI).forEach(p => {
    if (room.board.length >= 3) {
      const ph = evalBest([...p.cards, ...room.board]);
      const wh = evalBest([...winner.cards, ...room.board]);
      if (cmpE(ph, wh) > 0) p.stat.ghostWins++;
    }
  });

  // Update all stats
  room.players.forEach(p => {
    p.stat.handsPlayed++;
    p.stat.chips = p.chips;
    p.stat.chipHistory.push(p.chips);
    if (!p.isAI && p.curPF) {
      p.stat.handLog.push({
        num: room.handNum,
        cards: [...p.cards],
        board: [...room.board],
        pfLabel: p.curPF.label,
        pfPts: p.curPF.pts,
        won: p.id === winner.id,
        folded: p.folded,
        ghostWin: p.stat.ghostWins > 0,
        winAmt: p.id === winner.id ? room.pot : 0
      });
    }
  });

  broadcastRoom(room);
  io.to(room.code).emit('hand_over', {
    winnerId: winner.id,
    winnerName: winner.name,
    pot: room.pot,
    players: room.players.map(p => ({
      id: p.id, name: p.name,
      cards: p.cards,
      handName: room.board.length >= 3 ? evalBest([...p.cards, ...room.board]).name : null
    }))
  });

  // Next hand after 3s
  setTimeout(() => { if (rooms[room.code]) dealHand(room); }, 3000);
}

// ─── SOCKET.IO ───
io.on('connection', (socket) => {
  // Create room
  socket.on('create_room', ({ name, startChips, bb, sb, numAI }) => {
    const code = createRoom(name, startChips || 1000, bb || 20, sb || 10, 9);
    const room = getRoom(code);
    addPlayer(room, name, socket.id);
    // Add AI players
    const aiNames = ['Aleksander', 'Nora', 'Viktor', 'Sofia', 'Lars'];
    const aiEmojis = ['🎩', '🦊', '🤠', '💎', '🧊'];
    for (let i = 0; i < (numAI || 3); i++) {
      addPlayer(room, aiNames[i] + ' (AI)', null, true);
      room.players[room.players.length - 1].emoji = aiEmojis[i];
    }
    socket.join(code);
    socket.emit('room_created', { code, url: '/room/' + code });
    dealHand(room);
  });

  // Join room
  socket.on('join_room', ({ code, name }) => {
    const room = getRoom(code.toUpperCase());
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.players.filter(p => !p.isAI).length >= room.maxPlayers) {
      socket.emit('error', 'Room is full'); return;
    }
    // Replace an AI slot with this real player if possible, else add
    const aiSlot = room.players.find(p => p.isAI);
    if (aiSlot) {
      aiSlot.isAI = false;
      aiSlot.name = name;
      aiSlot.socketId = socket.id;
      aiSlot.id = socket.id;
    } else {
      addPlayer(room, name, socket.id);
    }
    socket.join(code.toUpperCase());
    socket.emit('joined_room', { code: code.toUpperCase() });
    broadcastRoom(room);
  });

  // Player action
  socket.on('player_action', ({ code, action, amount }) => {
    const room = getRoom(code);
    if (!room || room.over) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || room.queue[0] !== player.id) return;
    applyAction(room, player.id, action, amount || 0);
    broadcastRoom(room);
    tickRoom(room);
  });

  // End session
  socket.on('end_session', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    room.over = true;
    if (room.actionTimeout) clearTimeout(room.actionTimeout);
    const stats = room.players.map(p => ({
      name: p.name,
      emoji: p.emoji || '😎',
      isAI: p.isAI,
      stat: p.stat,
      chips: p.chips
    }));
    io.to(code).emit('session_ended', { stats, handNum: room.handNum });
    delete rooms[code];
  });

  // Disconnect
  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const p = room.players.find(x => x.socketId === socket.id);
      if (p) {
        p.socketId = null;
        p.isAI = true; // hand over to AI
        broadcastRoom(room);
      }
    }
  });
});

// Room URL route
app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('PokerTrack running on port ' + PORT));
