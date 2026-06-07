const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const engine = require('./src/engine');
const {
  createRoom, getRoom, deleteRoom, filledSeats, seatPlayer, seatOfSocket,
  broadcast, buildView, dealHand, applyAction, scheduleNext, startBlindTimer, stopBlindTimer, showCardsAction
} = engine;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
engine.attach(io);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

io.on('connection', socket => {
  let myRoom = null;
  let mySeat = null;

  socket.on('create_room', ({ name, startChips, sb, bb, maxSeats, blindUpMin, turnSec }) => {
    name = (name || '').toString().trim().slice(0, 14) || 'Host';
    startChips = Math.max(1, startChips || 1000);
    sb = Math.max(1, sb || 10);
    bb = Math.max(sb * 2, bb || 20); // big blind at least 2x small blind
    blindUpMin = Math.max(0, Math.min(120, +blindUpMin || 0));
    turnSec = turnSec === 0 ? 0 : Math.max(8, Math.min(120, +turnSec || 30));
    const code = createRoom(name, socket.id, startChips, sb, bb, maxSeats, blindUpMin, turnSec);
    myRoom = code;
    socket.join(code);
    const room = getRoom(code);
    seatPlayer(room, 0, name, socket.id, startChips); // host takes seat 0
    mySeat = 0;
    socket.emit('room_created', { code, url: '/room/' + code });
    broadcast(room);
  });

  socket.on('join_room', ({ code, name }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('err', 'Room not found'); return; }
    name = (name || '').toString().trim().slice(0, 14) || 'Player';
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
    if (room.phase === 'playing' && !room.over) { socket.emit('err', 'Wait for the hand to finish'); return; }

    const existingIdx = seatOfSocket(room, socket.id);
    if (existingIdx !== -1) {
      // Move the existing player rather than creating a duplicate seat.
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
    broadcast(room);
    scheduleNext(room);
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
    socket.emit('state_public', buildView(room, null));
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
    if (p) {
      p.connected = false;
      broadcast(room);
      if (!room.over && room.queue[0] === mySeat) {
        if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
        room.actionTimer = setTimeout(() => {
          const call = Math.max(0, room.curBet - p.bet);
          applyAction(room, mySeat, call > 0 ? 'fold' : 'check'); broadcast(room); scheduleNext(room);
        }, 12000); // grace period to rejoin before auto-acting
      }
    }
  });

  // Rejoin your existing seat after a refresh/disconnect.
  socket.on('reconnect_room', ({ code, name }) => {
    const room = getRoom(code);
    if (!room) { socket.emit('reconnect_failed'); return; }
    const p = filledSeats(room).find(p => p.name === name);
    if (!p) { socket.emit('reconnect_failed'); return; }
    p.socketId = socket.id;
    p.connected = true;
    mySeat = p.seatIndex;
    myRoom = room.code;
    socket.join(room.code);
    socket.emit('joined_room', { code: room.code, seatIndex: p.seatIndex });
    // if we came back on our own turn, restart the action clock for us
    if (!room.over && room.queue[0] === p.seatIndex) {
      if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
      scheduleNext(room);
    } else {
      broadcast(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('PokerTrack on port ' + PORT));
