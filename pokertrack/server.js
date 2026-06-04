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

// ── GTO SCORING ──
function scoreGTO(action, pfPts, position, street, boardRank, potOdds) {
  const posThresh = {BTN:4,CO:5,MP:6,UTG:7,SB:4,BB:9};
  const thresh = posThresh[position] || 6;
  let correct, note;
  if (street==='preflop') {
    if (action==='fold') {
      correct = pfPts < thresh;
      note = correct ? 'Correct fold — below positional range' : 'Should open — hand is in range for '+position;
    } else {
      correct = pfPts >= thresh;
      note = correct ? 'Correct — hand in positional range' : 'Marginal open — below standard range for '+position;
    }
  } else {
    if (action==='fold') {
      correct = boardRank < 2 && potOdds < 0.25;
      note = correct ? 'Correct fold — weak hand + bad odds' : boardRank>=3?'Should continue — strong hand':'Borderline — check pot odds';
    } else if (action==='raise') {
      correct = boardRank >= 4;
      note = correct ? 'Good value raise' : 'Thin raise — GTO prefers check/call here';
    } else {
      correct = boardRank >= 1 || potOdds > 0.3;
      note = correct ? 'Reasonable continue' : 'GTO leans fold — weak hand + poor odds';
    }
  }
  return {correct, note};
}

function mkStat(startChips) {
  return {startChips,chips:startChips,handsPlayed:0,handsWon:0,vpip:0,folds:0,ghostWins:0,luckPts:0,luckHands:0,gtoDecisions:[],chipHistory:[startChips],handLog:[]};
}

// ── ROOM CREATION ──
function createRoom(hostName, hostSocketId, startChips, sb, bb) {
  const code = makeCode();
  rooms[code] = {
    code,
    hostId: hostSocketId,
    sb, bb,
    startChips,
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
    folded: false,
    lastAction: '',
    seatIndex,
    curPF: null,
    connected: true
  };
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
    p.folded = false; p.cards = []; p.bet = 0; p.lastAction = '';
    if (p.chips <= 0) p.chips = room.startChips;
  });

  // advance dealer to next filled seat
  const filled = room.seats.map((s,i)=>s?i:-1).filter(i=>i>=0);
  if (room.dealer === -1) {
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

  // post blinds — SB and BB are next two seats after dealer
  const sbIdx = nextSeat(room, room.dealer);
  const bbIdx = nextSeat(room, sbIdx);
  postBlind(room, sbIdx, room.sb);
  postBlind(room, bbIdx, room.bb);

  // preflop action starts left of BB
  const startIdx = nextSeat(room, bbIdx);
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
  const pay = Math.min(amt, p.chips);
  p.chips -= pay; p.bet += pay; room.pot += pay;
  p.lastAction = 'Blind ' + pay;
}

function buildQueue(room, startSeatIdx) {
  // Build ordered list of active (non-folded) seat indexes starting from startSeatIdx
  const q = [];
  let idx = startSeatIdx;
  const filled = filledSeats(room).length;
  for (let i=0;i<filled;i++) {
    const seat = room.seats[idx];
    if (seat && !seat.folded) q.push(idx);
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
    const pay = Math.min(call, p.chips);
    p.chips -= pay; p.bet += pay; room.pot += pay;
    p.lastAction = 'Call ' + pay;
    p.stat.vpip++;
    trackGTO(room, p, 'call');
  } else if (action === 'raise') {
    const minRaise = room.curBet + room.bb;
    const target = Math.max(raiseAmt || 0, minRaise);
    const extra = Math.min(target - p.bet, p.chips);
    if (extra <= 0) return false;
    p.chips -= extra; p.bet += extra; room.pot += extra;
    room.curBet = p.bet;
    p.lastAction = 'Raise ' + p.bet;
    p.stat.vpip++;
    trackGTO(room, p, 'raise');
    // Everyone else needs to act again — rebuild queue excluding this player
    const nextStart = nextSeat(room, seatIdx);
    room.queue = buildQueue(room, nextStart);
    return true;
  } else if (action === 'allin') {
    const extra = p.chips;
    p.chips = 0; p.bet += extra; room.pot += extra;
    if (p.bet > room.curBet) room.curBet = p.bet;
    p.lastAction = 'All-in ' + p.bet;
    p.stat.vpip++;
    if (p.bet > room.curBet) {
      const nextStart = nextSeat(room, seatIdx);
      room.queue = buildQueue(room, nextStart);
      return true;
    }
  }

  room.queue.shift();
  return true;
}

function trackGTO(room, player, action) {
  const boardEval = room.board.length >= 3 ? evalBest([...player.cards, ...room.board]) : null;
  const boardRank = boardEval ? boardEval.rank : 0;
  const callAmt = Math.max(0, room.curBet - player.bet);
  const potOdds = room.pot > 0 ? callAmt / (room.pot + callAmt) : 0;
  const positions = ['UTG','MP','CO','BTN','SB','BB'];
  const filled = room.seats.map((s,i)=>s?i:-1).filter(i=>i>=0);
  const posIdx = (filled.indexOf(player.seatIndex) - filled.indexOf(room.dealer) + filled.length) % filled.length;
  const position = positions[Math.min(posIdx, positions.length-1)];
  const res = scoreGTO(action, player.curPF?.pts||0, position, room.street, boardRank, potOdds);
  player.stat.gtoDecisions.push({hand:room.handNum, street:room.street, action, position, correct:res.correct, note:res.note});
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

function endHand(room) {
  room.over = true;
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }

  const active = activePlayers(room);
  let winner;

  if (active.length === 1) {
    winner = active[0];
  } else {
    const evals = active.map(p => ({ p, ev: evalBest([...p.cards, ...room.board]) }));
    evals.sort((a,b) => cmpE(b.ev, a.ev));
    winner = evals[0].p;
    // show winning hand name
    winner.lastAction = evals[0].ev.name;
  }

  winner.chips += room.pot;
  winner.stat.handsWon++;

  // ghost wins
  filledSeats(room).filter(p=>p.folded).forEach(p => {
    if (room.board.length >= 3) {
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
        won: p === winner,
        folded: p.folded,
        ghostWin: p.folded && room.board.length>=3 && cmpE(evalBest([...p.cards,...room.board]), evalBest([...winner.cards,...room.board]))>0,
        winAmt: p === winner ? room.pot : 0
      });
    }
  });

  broadcast(room);

  // send hand_over event with winner info
  io.to(room.code).emit('hand_over', {
    winnerId: winner.id,
    winnerName: winner.name,
    pot: room.pot,
    handName: winner.lastAction,
    seats: room.seats.map((s,i) => s ? {seatIndex:i, name:s.name, cards:s.cards, folded:s.folded} : null)
  });

  // next hand after 4s
  room.actionTimer = setTimeout(() => { if (rooms[room.code]) dealHand(room); }, 4000);
}

// ── SOCKET.IO ──
io.on('connection', socket => {
  let myRoom = null;
  let mySeat = null;

  socket.on('create_room', ({ name, startChips, sb, bb }) => {
    // validate blinds
    if (bb < sb*2) bb = sb*2;
    const code = createRoom(name, socket.id, startChips||1000, sb||10, bb||20);
    myRoom = code;
    socket.join(code);
    const room = getRoom(code);
    // host takes seat 0
    seatPlayer(room, 0, name, socket.id, startChips||1000);
    mySeat = 0;
    socket.emit('room_created', { code, url: '/room/'+code });
    broadcast(room);
  });

  socket.on('join_room', ({ code, name }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('err', 'Room not found'); return; }
    // find first empty seat
    const emptyIdx = room.seats.findIndex(s=>!s);
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
    if (!room || room.seats[seatIndex]) { socket.emit('err', 'Seat taken'); return; }
    myRoom = room.code;
    mySeat = seatIndex;
    socket.join(room.code);
    seatPlayer(room, seatIndex, name, socket.id, room.startChips);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('PokerTrack on port ' + PORT));
