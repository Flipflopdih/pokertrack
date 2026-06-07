const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const engine = require('./src/engine');
const {
  createRoom, getRoom, deleteRoom, filledSeats, seatPlayer, seatOfSocket,
  broadcast, buildView, dealHand, applyAction, scheduleNext, startBlindTimer, stopBlindTimer,
  showCardsAction, afterAction, seatByPlayer, anyConnected
} = engine;

// Keep a room while someone's connected; once everyone's gone, tear it down after a grace
// period so old invite links die and reconnects fall back to a fresh lobby.
function touchRoom(room) { if (room && room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; } }
function maybeCleanupRoom(room) {
  if (!room || anyConnected(room)) { touchRoom(room); return; }
  if (room.cleanupTimer) return;
  room.cleanupTimer = setTimeout(() => {
    const r = getRoom(room.code);
    if (r && !anyConnected(r)) { stopBlindTimer(r); if (r.actionTimer) clearTimeout(r.actionTimer); deleteRoom(r.code); }
  }, 30000);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
engine.attach(io);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

io.on('connection', socket => {
  let myRoom = null;
  let mySeat = null;
  let myPid = null;

  socket.on('create_room', ({ name, startChips, sb, bb, maxSeats, blindUpMin, turnSec, playerId }) => {
    name = (name || '').toString().trim().slice(0, 14) || 'Host';
    startChips = Math.max(1, startChips || 1000);
    sb = Math.max(1, sb || 10);
    bb = Math.max(sb * 2, bb || 20); // big blind at least 2x small blind
    blindUpMin = Math.max(0, Math.min(120, +blindUpMin || 0));
    turnSec = turnSec === 0 ? 0 : Math.max(8, Math.min(120, +turnSec || 30));
    const code = createRoom(name, socket.id, startChips, sb, bb, maxSeats, blindUpMin, turnSec);
    myRoom = code; myPid = playerId || socket.id;
    socket.join(code);
    const room = getRoom(code);
    room.hostPid = myPid; // remember the host by stable id so reconnects keep host
    // host is NOT auto-seated — they pick a seat + buy-in on the table view
    socket.emit('room_created', { code, url: '/room/' + code });
    broadcast(room);
  });

  socket.on('join_room', ({ code, name, playerId }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('err', 'Room not found'); return; }
    touchRoom(room);
    myRoom = room.code; myPid = playerId || socket.id;
    // name is taken on take_seat
    socket.join(room.code);
    // already seated here (reconnect)? resume that seat. otherwise they pick a seat.
    const existing = playerId && seatByPlayer(room, playerId);
    if (existing) {
      existing.socketId = socket.id; existing.connected = true; existing.sittingOut = false;
      if (room.hostPid === playerId) room.hostId = socket.id;
      mySeat = existing.seatIndex;
      socket.emit('joined_room', { code: room.code, seatIndex: existing.seatIndex });
    } else {
      socket.emit('room_joined', { code: room.code });
    }
    broadcast(room);
  });

  socket.on('take_seat', ({ code, seatIndex, name, playerId, chips }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('err', 'Room not found'); return; }
    if (seatIndex < 0 || seatIndex >= room.maxSeats) return;
    if (room.seats[seatIndex]) { socket.emit('err', 'Seat taken'); return; }
    if (room.phase === 'playing' && !room.over) { socket.emit('err', 'Wait for the hand to finish'); return; }
    touchRoom(room);
    const buyIn = Math.max(room.bb, Math.min(10000000, Math.round(+chips || room.startChips)));

    const existingIdx = seatOfSocket(room, socket.id);
    if (existingIdx !== -1) {
      // Move the existing player rather than creating a duplicate seat.
      const player = room.seats[existingIdx];
      player.seatIndex = seatIndex;
      room.seats[seatIndex] = player;
      room.seats[existingIdx] = null;
      if (room.dealer === existingIdx) room.dealer = seatIndex;
    } else {
      seatPlayer(room, seatIndex, (name || '').toString().trim().slice(0, 14) || 'Player', socket.id, buyIn, playerId || socket.id);
    }
    myRoom = room.code; mySeat = seatIndex; myPid = playerId || socket.id;
    socket.join(room.code);
    socket.emit('joined_room', { code: room.code, seatIndex });
    broadcast(room);
  });

  socket.on('chat', ({ code, text }) => {
    const room = getRoom(code || '');
    if (!room) return;
    text = (text || '').toString().replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return;
    const idx = seatOfSocket(room, socket.id);
    const name = idx >= 0 ? room.seats[idx].name : 'Spectator';
    io.to(room.code).emit('chat_msg', { name, text });
  });

  socket.on('start_game', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    if (filledSeats(room).length < 2) { socket.emit('err', 'Need at least 2 players'); return; }
    startBlindTimer(room);
    dealHand(room);
  });

  // emoji reactions
  const EMOJIS = ['😂','🔥','😭','👍','😎','🤔','💩','🎉','😱','🤝'];
  socket.on('react', ({ code, emoji }) => {
    const room = getRoom(code);
    if (!room || !EMOJIS.includes(emoji)) return;
    const idx = seatOfSocket(room, socket.id);
    if (idx < 0) return;
    io.to(room.code).emit('reaction', { seatIndex: idx, emoji });
  });

  socket.on('action', ({ code, action, amount }) => {
    const room = getRoom(code);
    if (!room || mySeat === null) return;
    if (!applyAction(room, mySeat, action, amount || 0)) return;
    // a brief beat so actions (especially checks) don't blur past instantly
    afterAction(room, action === 'check' ? 500 : action === 'fold' ? 280 : 320);
  });

  // sit out / come back (takes effect on the next deal)
  socket.on('sit_out', ({ code, on }) => {
    const room = getRoom(code);
    if (!room) return;
    const idx = seatOfSocket(room, socket.id);
    if (idx < 0) return;
    room.seats[idx].sittingOut = !!on;
    broadcast(room);
  });

  // rebuy / top up to the starting stack, only between hands
  socket.on('topup', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    const idx = seatOfSocket(room, socket.id);
    if (idx < 0) return;
    const p = room.seats[idx];
    const inHand = room.phase === 'playing' && !room.over && !p.folded && p.cards.length > 0;
    if (inHand) { socket.emit('err', 'Top up between hands'); return; }
    if (p.chips < room.startChips) { p.chips = room.startChips; broadcast(room); socket.emit('notice', 'Topped up to ' + room.startChips); }
    else socket.emit('notice', 'You already have a full stack');
  });

  // host-only "Luck mode" — rig a seat to hit a monster on the river (joke/sandbox)
  socket.on('set_rig', ({ code, seatIndex, on }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    const p = room.seats[seatIndex];
    if (p) { p.rigged = !!on; broadcast(room); }
  });

  socket.on('show_cards', ({ code }) => {
    const room = getRoom(code);
    if (room) showCardsAction(room, socket.id);
  });

  // join as a read-only spectator (no seat)
  socket.on('spectate', ({ code }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('err', 'Room not found'); return; }
    myRoom = room.code;
    socket.join(room.code);
    socket.emit('spectating', { code: room.code });
    socket.emit('state', buildView(room, socket.id));
  });

  socket.on('update_settings', ({ code, sb, bb, startChips }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    if (bb < sb * 2) { socket.emit('err', 'Big blind must be at least 2x small blind'); return; }
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
    stopBlindTimer(room);
    const players = room.seats.filter(Boolean);
    const acc = st => { const d = st.gtoDecisions; return d.length ? Math.round(d.filter(x => x.correct).length / d.length * 100) : 0; };
    const leaderboard = players.map(p => ({
      name: p.name, seatIndex: p.seatIndex, chips: p.chips,
      net: p.chips - p.stat.startChips, wins: p.stat.handsWon,
      handsPlayed: p.stat.handsPlayed, gtoAcc: acc(p.stat)
    })).sort((a, b) => b.chips - a.chips);
    // each player gets only their own detailed stats + the shared leaderboard
    players.forEach(p => {
      if (p.socketId) io.to(p.socketId).emit('session_ended', {
        you: { name: p.name, chips: p.chips, stat: p.stat }, leaderboard, handNum: room.handNum
      });
    });
    deleteRoom(code);
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    const room = getRoom(myRoom);
    if (!room) return;
    const p = room.seats[mySeat];
    // Ignore if this player already reconnected on a newer socket (race on refresh).
    if (p && p.socketId === socket.id) {
      p.connected = false;
      p.sittingOut = true; // go "offline" → auto sit out next hand so the table doesn't wait on you
      broadcast(room);
      if (!room.over && !room.paused && room.queue[0] === mySeat) {
        if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
        const seat = mySeat;
        room.actionTimer = setTimeout(() => {
          const call = Math.max(0, room.curBet - p.bet);
          if (applyAction(room, seat, call > 0 ? 'fold' : 'check')) afterAction(room, 320);
        }, 12000); // grace period to rejoin before auto-acting on the current hand
      }
    }
    maybeCleanupRoom(room); // if everyone's gone, the room (and its link) dies after a grace period
  });

  // Rejoin your existing seat after a refresh/disconnect (matched by stable player id).
  socket.on('reconnect_room', ({ code, name, playerId }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('reconnect_failed'); return; }
    let p = (playerId && seatByPlayer(room, playerId)) || filledSeats(room).find(s => s.name === name);
    if (!p) { socket.emit('reconnect_failed'); return; }
    touchRoom(room);
    p.socketId = socket.id;
    p.connected = true;
    p.sittingOut = false; // back online → rejoin the action next hand
    if (playerId) p.playerId = playerId;
    if (room.hostPid && room.hostPid === p.playerId) room.hostId = socket.id; // restore host
    mySeat = p.seatIndex; myRoom = room.code; myPid = p.playerId;
    socket.join(room.code);
    socket.emit('joined_room', { code: room.code, seatIndex: p.seatIndex });
    if (!room.over && !room.paused && room.queue[0] === p.seatIndex) {
      if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
      scheduleNext(room); // it's our turn again — restart the clock
    } else {
      broadcast(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('PokerTrack on port ' + PORT));
