// ── CARD DISPLAY (SVG, four-colour deck) ──
const SYM = {s:'♠',h:'♥',d:'♦',c:'♣'};
const SUIT_COL = {s:'#23262b',h:'#c0392b',d:'#2e72b8',c:'#1e8a4c'};

function cardFaceSVG(c) {
  const col = SUIT_COL[c.s], g = SYM[c.s], r = c.r;
  const rf = r === 'T' ? 17 : 21;
  const idx = a => '<text x="11" y="22" text-anchor="middle" font-family="DM Sans,sans-serif" font-weight="700" font-size="' + rf + '" fill="' + col + '">' + r + '</text>'
    + '<text x="11" y="35" text-anchor="middle" font-size="12" fill="' + col + '">' + g + '</text>';
  return '<svg viewBox="0 0 70 98">'
    + '<rect x="1.5" y="1.5" width="67" height="95" rx="7" fill="url(#pt-cardg)" stroke="rgba(20,20,20,.16)" stroke-width="1"/>'
    + idx()
    + '<text x="35" y="64" text-anchor="middle" font-size="42" fill="' + col + '" opacity=".92">' + g + '</text>'
    + '<g transform="rotate(180 35 49)">' + idx() + '</g>'
    + '</svg>';
}
function backFaceSVG() {
  return '<svg viewBox="0 0 70 98">'
    + '<rect x="1.5" y="1.5" width="67" height="95" rx="7" fill="url(#pt-backg)"/>'
    + '<rect x="5" y="5" width="60" height="88" rx="5" fill="url(#pt-lattice)" stroke="rgba(201,168,76,.55)" stroke-width="1.1"/>'
    + '<text x="35" y="57" text-anchor="middle" font-size="24" fill="rgba(201,168,76,.85)">♠</text>'
    + '</svg>';
}
function cardEl(c, sz) {
  const d = document.createElement('div');
  d.className = 'card ' + sz;
  d.innerHTML = c ? cardFaceSVG(c) : backFaceSVG();
  return d;
}
function cardHTML(c, sz) {
  return '<div class="card ' + sz + '">' + (c ? cardFaceSVG(c) : backFaceSVG()) + '</div>';
}
function backCard(sz) {
  const d = document.createElement('div');
  d.className = 'card ' + sz;
  d.innerHTML = backFaceSVG();
  return d;
}

// ── STATE ──
let socket, roomCode, mySeatIndex, myName, isHost;
let lastState = null;
let inviteUrl = '';
let raiseCtx = null;
let myTurnWas = false;
let prevHandNum = 0, prevActions = {};

// ── SOUND (real samples via Web Audio, low-latency + overlapping) ──
const SOUND_FILES = { deal:'/sounds/card.mp3', check:'/sounds/takecard2.mp3', call:'/sounds/chips1.mp3', raise:'/sounds/chips2.mp3', fold:'/sounds/takecard.mp3', allin:'/sounds/allin.mp3' };
const SOUND_CAP = {};
const SOUND_GAIN = { check: 0.5, deal: 0.7, call: 0.85, raise: 0.9, fold: 0.75, allin: 1.0 };
const sfx = (() => {
  let ctx = null, muted = localStorage.getItem('pt-muted') === '1';
  const buffers = {};
  function preload() {
    Object.entries(SOUND_FILES).forEach(([k, url]) => {
      if (buffers[k] !== undefined) return;
      buffers[k] = null;
      fetch(url).then(r => r.arrayBuffer()).then(ab => ctx.decodeAudioData(ab)).then(b => buffers[k] = b).catch(() => {});
    });
  }
  function ensure() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } preload(); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(f, t0, dur, gain) { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'triangle'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); o.connect(g); g.connect(ctx.destination); o.start(t0); o.stop(t0 + dur + 0.02); }
  return {
    get muted() { return muted; },
    toggle() { muted = !muted; localStorage.setItem('pt-muted', muted ? '1' : '0'); if (!muted) ensure(); return muted; },
    init() { ensure(); },
    play(name) {
      if (muted || !ensure()) return;
      if (name === 'win') { const t = ctx.currentTime;[523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.09, 0.25, 0.13)); return; }
      const buf = buffers[name];
      if (!buf) { if (buffers[name] === undefined) preload(); return; }
      const src = ctx.createBufferSource(); src.buffer = buf;
      const g = ctx.createGain(); g.gain.value = SOUND_GAIN[name] != null ? SOUND_GAIN[name] : 0.8;
      src.connect(g); g.connect(ctx.destination); src.start();
      if (SOUND_CAP[name]) { g.gain.setValueAtTime(g.gain.value, ctx.currentTime + SOUND_CAP[name] - 0.15); g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + SOUND_CAP[name]); src.stop(ctx.currentTime + SOUND_CAP[name]); }
    }
  };
})();
function toggleMute() { const m = sfx.toggle(); const b = document.getElementById('btn-mute'); if (b) b.textContent = m ? '🔇' : '🔊'; }
// unlock + preload audio on the first user interaction
window.addEventListener('pointerdown', () => sfx.init(), { once: true });

// Play sounds by diffing successive states (deal on new hand, per-seat actions).
function soundsFromState(state) {
  if (state.phase !== 'playing') return;
  if (state.handNum !== prevHandNum) { if (prevHandNum !== 0) sfx.play('deal'); prevHandNum = state.handNum; prevActions = {}; }
  state.seats.forEach(s => {
    if (!s) return;
    const la = s.lastAction || '', prev = prevActions[s.seatIndex];
    if (la === prev) return;
    prevActions[s.seatIndex] = la;
    if (la.startsWith('Fold')) sfx.play('fold');
    else if (la.startsWith('Check')) sfx.play('check');
    else if (la.startsWith('Call')) sfx.play('call');
    else if (la.startsWith('Raise')) sfx.play('raise');
    else if (la.startsWith('All-in')) sfx.play('allin');
  });
}

// ── SOCKET ──
function initSocket() {
  socket = io();

  socket.on('room_created', ({ code, url }) => {
    roomCode = code;
    inviteUrl = window.location.origin + url;
    document.getElementById('lb-url').textContent = inviteUrl;
    document.getElementById('link-box').classList.add('show');
    document.getElementById('seat-invite-url').textContent = inviteUrl;
    document.getElementById('seat-code').textContent = code;
    document.getElementById('tb-code').textContent = code;
    showScreen('s-seats');
  });

  socket.on('joined_room', ({ code, seatIndex }) => {
    roomCode = code;
    mySeatIndex = seatIndex;
    inviteUrl = window.location.origin + '/room/' + code;
    document.getElementById('seat-invite-url').textContent = inviteUrl;
    document.getElementById('seat-code').textContent = code;
    document.getElementById('tb-code').textContent = code;
    showScreen('s-seats');
  });

  socket.on('state', state => {
    lastState = state;
    isHost = state.isHost;
    // find my seat
    const me = state.seats.find(s => s && s.isYou);
    if (me) mySeatIndex = me.seatIndex;
    const currentScreen = document.querySelector('.screen.active').id;
    if (state.phase === 'playing' && currentScreen !== 's-game') showScreen('s-game');
    if (state.phase === 'waiting' && currentScreen === 's-game') showScreen('s-seats');
    renderSeatChooser(state);
    if (state.phase === 'playing') renderGame(state);
    soundsFromState(state);
    updateSettingsBtn();
  });

  socket.on('state_public', state => {
    // update seat chooser if visible
    const cur = document.querySelector('.screen.active').id;
    if (cur === 's-seats') renderSeatChooser(state);
  });

  socket.on('hand_over', ({ winnerName, pot, handName, seats }) => {
    sfx.play('win');
    setThink(winnerName + ' wins ' + pot + (handName ? ' — ' + handName : ''));
    // reveal all cards
    if (lastState) {
      seats.forEach(s => {
        if (!s) return;
        const ls = lastState.seats[s.seatIndex];
        if (ls) ls.cards = s.cards;
      });
      renderGame({ ...lastState, over: true });
    }
  });

  socket.on('settings_updated', ({ sb, bb, startChips }) => {
    toast('Blinds updated: ' + sb + ' / ' + bb);
    document.getElementById('sp-sb').value = sb;
    document.getElementById('sp-bb').value = bb;
  });

  socket.on('session_ended', ({ you, leaderboard, handNum }) => {
    buildResults(you, leaderboard, handNum);
    showScreen('s-results');
  });

  socket.on('chat_msg', addChatMsg);

  socket.on('err', msg => toast(msg));
}

// ── CHAT ──
function toggleChat() {
  const c = document.getElementById('chat');
  c.classList.toggle('closed');
  if (!c.classList.contains('closed')) {
    document.getElementById('btn-chat').classList.remove('chat-unread');
    const i = document.getElementById('chat-input'); if (i) i.focus();
    const m = document.getElementById('chat-msgs'); m.scrollTop = m.scrollHeight;
  }
}
function sendChat(e) {
  e.preventDefault();
  const inp = document.getElementById('chat-input');
  const text = inp.value.trim();
  if (!text || !socket || !roomCode) return;
  socket.emit('chat', { code: roomCode, text });
  inp.value = '';
}
function addChatMsg({ name, text }) {
  const m = document.getElementById('chat-msgs');
  const row = document.createElement('div');
  row.className = 'chat-row' + (name === myName ? ' me' : '');
  row.innerHTML = '<span class="chat-name">' + esc(name) + '</span><span class="chat-text">' + esc(text) + '</span>';
  m.appendChild(row);
  m.scrollTop = m.scrollHeight;
  if (document.getElementById('chat').classList.contains('closed')) document.getElementById('btn-chat').classList.add('chat-unread');
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

// ── LOBBY ACTIONS ──
function switchTab(t) {
  document.querySelectorAll('.tab').forEach((el, i) => el.classList.toggle('active', i === (t === 'create' ? 0 : 1)));
  document.getElementById('tab-create').classList.toggle('hidden', t !== 'create');
  document.getElementById('tab-join').classList.toggle('hidden', t === 'create');
}

function syncBlinds() {
  // keep big blind at least 2x the small blind as the host types
  const sb = +document.getElementById('c-sb').value || 0;
  const bbEl = document.getElementById('c-bb');
  if (+bbEl.value < sb * 2) bbEl.value = sb * 2;
}

function createRoom() {
  myName = document.getElementById('c-name').value.trim();
  if (!myName) { toast('Enter your name first'); return; }
  const chips = Math.max(1, +document.getElementById('c-chips').value || 1000);
  const sb = Math.max(1, +document.getElementById('c-sb').value || 10);
  let bb = Math.max(2, +document.getElementById('c-bb').value || 20);
  if (bb < sb * 2) { toast('Big blind must be at least 2× small blind'); return; }
  if (chips < bb) { toast('Starting chips should be at least one big blind'); return; }
  const maxSeats = +document.getElementById('c-maxseats').value || 8;
  initSocket();
  socket.emit('create_room', { name: myName, startChips: chips, sb, bb, maxSeats });
  document.getElementById('p-nameval').textContent = myName;
}

function joinRoom() {
  myName = document.getElementById('j-name').value.trim();
  const code = document.getElementById('j-code').value.trim().toUpperCase();
  if (!myName) { toast('Enter your name'); return; }
  if (!code) { toast('Enter a room code'); return; }
  initSocket();
  socket.emit('join_room', { code, name: myName });
  document.getElementById('p-nameval').textContent = myName;
}

function copyInvite() {
  const url = inviteUrl || window.location.href;
  navigator.clipboard.writeText(url).then(() => toast('Link copied!')).catch(() => toast(url));
}

// ── SEAT CHOOSER ──
function renderSeatChooser(state) {
  const grid = document.getElementById('seat-grid');
  grid.innerHTML = '';
  const maxSeats = state.maxSeats || (lastState && lastState.maxSeats) || 8;
  let filled = 0;
  const iAmSeated = state.seats && state.seats.some(s => s && s.id === (socket ? socket.id : null));
  for (let i = 0; i < maxSeats; i++) {
    const s = state.seats ? state.seats[i] : null;
    const btn = document.createElement('div');
    const isMe = s && s.id === (socket ? socket.id : null);
    const taken = !!s;
    if (taken) filled++;
    btn.className = 'seat-btn' + (taken ? (isMe ? ' mine' : ' taken') : '');
    btn.innerHTML = '<div class="sb-num">Seat ' + (i+1) + (isMe ? ' · You' : '') + '</div>'
      + '<div class="sb-name">' + (s ? s.name : 'Empty') + '</div>'
      + '<div class="sb-chips">' + (s ? s.chips + ' chips' : (iAmSeated ? 'Move here' : 'Sit here')) + '</div>';
    if (!taken) {
      btn.onclick = () => chooseSeat(i);
    }
    grid.appendChild(btn);
  }
  document.getElementById('seat-players').textContent = filled;
  document.getElementById('seat-max').textContent = maxSeats;
  // show start button — use lastState.isHost since state_public doesn't carry it
  const amHost = (lastState && lastState.isHost) || state.isHost || false;
  const startBtn = document.getElementById('btn-start-game');
  startBtn.style.display = (amHost && filled >= 2) ? 'block' : 'none';
  const waitMsg = document.getElementById('waiting-msg');
  waitMsg.textContent = filled < 2 ? 'Waiting for players… share the link to invite friends'
    : amHost ? 'Ready! Click "Start game" when everyone is seated.'
    : 'Waiting for the host to start the game…';
}

function chooseSeat(idx) {
  if (!socket) { toast('Connect first'); return; }
  socket.emit('take_seat', { code: roomCode, seatIndex: idx, name: myName });
  mySeatIndex = idx;
}

function startGame() {
  if (!socket) return;
  socket.emit('start_game', { code: roomCode });
}

// ── SETTINGS ──
function toggleSettings() {
  const panel = document.getElementById('settings-panel');
  const showing = panel.classList.toggle('show');
  if (showing && lastState) {
    document.getElementById('sp-sb').value = lastState.sb;
    document.getElementById('sp-bb').value = lastState.bb;
    if (lastState.startChips) document.getElementById('sp-start').value = lastState.startChips;
    // build player chip editors
    const div = document.getElementById('sp-players');
    div.innerHTML = '';
    lastState.seats.forEach(s => {
      if (!s) return;
      const row = document.createElement('div');
      row.className = 'player-chip-row';
      row.innerHTML = '<span class="pcr-name">' + s.name + '</span>'
        + '<input class="pcr-input" type="number" id="pcr-' + s.seatIndex + '" value="' + s.chips + '" min="0">'
        + '<button class="pcr-btn" onclick="setChips(' + s.seatIndex + ')">Set</button>';
      div.appendChild(row);
    });
  }
}

function updateSettingsBtn() {
  document.getElementById('btn-settings').style.display = isHost ? 'block' : 'none';
}

function saveSettings() {
  const sb = +document.getElementById('sp-sb').value;
  const bb = +document.getElementById('sp-bb').value;
  const startChips = +document.getElementById('sp-start').value || undefined;
  if (bb < sb * 2) { toast('Big blind must be at least 2× small blind'); return; }
  socket.emit('update_settings', { code: roomCode, sb, bb, startChips });
  toggleSettings();
}

function setChips(seatIndex) {
  const chips = +document.getElementById('pcr-' + seatIndex).value;
  socket.emit('update_chips', { code: roomCode, seatIndex, chips });
  toast('Chips updated');
}

// ── GAME RENDER ──
const SEAT_POS = [
  {x:'50%', y:'17%'},  // seat 0 — top center
  {x:'79%', y:'24%'},  // seat 1 — top right
  {x:'90%', y:'46%'},  // seat 2 — right
  {x:'79%', y:'68%'},  // seat 3 — bottom right
  {x:'50%', y:'75%'},  // seat 4 — bottom center (not used — player sits here)
  {x:'21%', y:'68%'},  // seat 5 — bottom left
  {x:'10%', y:'46%'},  // seat 6 — left
  {x:'21%', y:'24%'},  // seat 7 — top left
];

function actClass(t) {
  return t.startsWith('Fold') ? 'tact-fold'
    : t.startsWith('Raise') ? 'tact-raise'
    : t.startsWith('Call') ? 'tact-call'
    : t.startsWith('Check') ? 'tact-check'
    : t.startsWith('Blind') ? 'tact-blind'
    : t.startsWith('All') ? 'tact-allin' : '';
}

// A chip-stack bet marker, placed ~42% of the way from a seat toward the pot.
function betChip(pos, center, amt) {
  const px = parseFloat(pos.x), py = parseFloat(pos.y);
  const d = document.createElement('div');
  d.className = 'tbet';
  d.style.left = (px + (center.x - px) * 0.42) + '%';
  d.style.top = (py + (center.y - py) * 0.42) + '%';
  d.textContent = amt;
  return d;
}

function renderGame(state) {
  document.getElementById('tb-hand').textContent = 'Hand #' + state.handNum;
  document.getElementById('tb-blinds').textContent = 'NLH · ' + state.sb + '/' + state.bb;
  document.getElementById('tb-code').textContent = state.code || roomCode;

  // Board
  const bc = document.getElementById('cboard');
  bc.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    if (i < state.board.length) bc.appendChild(cardEl(state.board[i], 'lg'));
    else { const ph = document.createElement('div'); ph.className='board-slot'; bc.appendChild(ph); }
  }
  document.getElementById('cpot').innerHTML = state.pot > 0 ? '<span class="cpot-l">POT</span>' + state.pot : '';
  document.getElementById('cstreet').textContent = state.street ? state.street.toUpperCase() : '';

  const me = state.seats.find(s => s && s.isYou);
  const maxSeats = state.maxSeats || 8;
  const center = { x: 50, y: 46 };

  // Render seats — occupied players + faint placeholders to fill the table
  const wrap = document.getElementById('tseats');
  const betWrap = document.getElementById('tbets');
  wrap.innerHTML = '';
  betWrap.innerHTML = '';

  for (let i = 0; i < maxSeats; i++) {
    const s = state.seats[i];
    if (s && s.isYou) continue; // hero renders at the bottom
    const pos = SEAT_POS[i] || SEAT_POS[0];
    const seat = document.createElement('div');
    seat.style.left = pos.x;
    seat.style.top = pos.y;

    if (!s) {
      seat.className = 'tseat empty';
      seat.innerHTML = '<div class="av">SIT</div>'
        + '<div class="tseat-plate"><div class="tseat-name">Seat ' + (i+1) + '</div></div>';
      wrap.appendChild(seat);
      continue;
    }

    seat.className = 'tseat';
    const isTurn = s.isTurn && !state.over;
    const avCls = 'av' + (s.folded ? ' folded-av' : '') + (isTurn ? ' myturn' : '');
    const initials = s.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();

    let cardsHtml = '';
    if (s.cards) s.cards.forEach(c => {
      cardsHtml += c ? cardHTML(c, 'xs' + (s.folded ? ' ghost-card' : '')) : cardHTML(null, 'xs');
    });

    const actTxt = s.lastAction || '';
    seat.innerHTML = '<div class="' + avCls + '">' + initials
      + (s.isDealer ? '<div class="dchip">D</div>' : '') + '</div>'
      + '<div class="tseat-plate"><div class="tseat-name">' + s.name
      + (s.wins > 0 ? '<span class="tseat-wins">🏆' + s.wins + '</span>' : '') + '</div>'
      + '<div class="tseat-chips">' + s.chips + '</div></div>'
      + '<div class="tseat-cards">' + cardsHtml + '</div>'
      + '<div class="tseat-act ' + actClass(actTxt) + '">' + actTxt + '</div>';
    wrap.appendChild(seat);

    if (s.bet > 0) betWrap.appendChild(betChip(pos, center, s.bet));
  }

  // hero's own bet chip (hero sits bottom-centre)
  if (me && me.bet > 0) betWrap.appendChild(betChip({ x: '50%', y: '86%' }, center, me.bet));

  // My cards + info
  if (me) {
    const ph = document.getElementById('p-hole');
    ph.innerHTML = '';
    if (me.cards) {
      me.cards.forEach(c => {
        if (!c) { ph.appendChild(backCard('xl')); return; }
        const el = cardEl(c, 'xl');
        if (me.folded) el.classList.add('ghost-card');
        ph.appendChild(el);
      });
    }
    document.getElementById('p-chipsval').textContent = me.chips + ' chips';
    document.getElementById('p-wins').textContent = me.wins > 0 ? '🏆' + me.wins : '';
    document.getElementById('p-hand').textContent = state.myHand || '';

    // action bar
    const myTurn = me.isTurn && !state.over;
    if (myTurn) {
      const call = Math.max(0, state.curBet - me.bet);
      const canCheck = call === 0;

      // Call: enabled only when there's something to call
      const callBtn = document.getElementById('btn-call');
      setBtnEnabled(callBtn, !canCheck);
      callBtn.querySelector('.albl').textContent = canCheck ? 'Call'
        : call >= me.chips ? 'All-in ' + me.chips : 'Call ' + call;

      // Check: enabled only when nothing to call
      setBtnEnabled(document.getElementById('btn-check'), canCheck);

      // Raise / Bet: enabled only when the player has chips beyond the call
      const minTotal = Math.max(state.bb, state.curBet + state.bb); // min legal total bet
      const maxTotal = me.bet + me.chips;                          // all-in total
      const canRaise = me.chips > call && maxTotal > state.curBet;
      const raiseBtn = document.getElementById('btn-raise-open');
      raiseBtn.querySelector('.albl').textContent = state.curBet === 0 ? 'Bet' : 'Raise';
      setBtnEnabled(raiseBtn, canRaise);
      if (canRaise) {
        const lo = Math.min(minTotal, maxTotal);
        const sl = document.getElementById('rslider');
        sl.min = lo; sl.max = maxTotal; sl.step = Math.max(1, state.sb);
        if (+sl.value < lo || +sl.value > maxTotal) sl.value = lo;
        raiseCtx = { pot: state.pot, curBet: state.curBet, bet: me.bet, lo, hi: maxTotal };
        onRaiseInput('slider');
      } else {
        raiseCtx = null;
      }

      // On a fresh turn, always start on the primary panel
      if (!myTurnWas) showRaisePanel(false);
      myTurnWas = true;
      document.getElementById('abar').classList.remove('off');
    } else {
      myTurnWas = false;
      showRaisePanel(false);
      document.getElementById('abar').classList.add('off');
    }
  }
}

// Enable/disable an action button (keeps a fixed PokerNow-style layout).
function setBtnEnabled(btn, on) {
  btn.classList.toggle('dis', !on);
  btn.disabled = !on;
}

// Toggle between the primary buttons and the raise-sizing panel.
function showRaisePanel(open) {
  document.getElementById('abar-main').classList.toggle('hidden', open);
  document.getElementById('abar-raise').classList.toggle('hidden', !open);
}
function openRaise() {
  if (!raiseCtx) return;
  document.getElementById('rslider').value = raiseCtx.lo; // always open at the minimum raise
  showRaisePanel(true);
  onRaiseInput('slider');
}
function closeRaise() { showRaisePanel(false); }
function confirmRaise() {
  if (!raiseCtx) return;
  send('raise');
  showRaisePanel(false);
}

// Keep the slider, number box and Bet/Raise label in sync.
function onRaiseInput(src) {
  if (!raiseCtx) return;
  const sl = document.getElementById('rslider');
  const inp = document.getElementById('rinput');
  let v = src === 'input' ? +inp.value : +sl.value;
  if (isNaN(v)) v = raiseCtx.lo;
  v = Math.max(raiseCtx.lo, Math.min(raiseCtx.hi, Math.round(v)));
  sl.value = v;
  if (src !== 'input' || document.activeElement !== inp) inp.value = v;
  const isBet = raiseCtx.curBet === 0 || raiseCtx.bet >= raiseCtx.curBet;
  document.querySelector('#btn-raise-confirm .albl').textContent = (isBet ? 'Bet ' : 'Raise ') + v;
}

// Quick pot-relative sizing buttons.
function setSize(frac) {
  if (!raiseCtx) return;
  let target;
  if (frac === 'max') target = raiseCtx.hi;
  else if (frac === 'min') target = raiseCtx.lo;
  else target = raiseCtx.bet + Math.round(frac * raiseCtx.pot);
  target = Math.max(raiseCtx.lo, Math.min(raiseCtx.hi, target));
  document.getElementById('rslider').value = target;
  onRaiseInput('slider');
}

function send(action) {
  if (!socket || !roomCode) return;
  const amount = action === 'raise' ? +document.getElementById('rslider').value : 0;
  socket.emit('action', { code: roomCode, action, amount });
  document.getElementById('abar').classList.add('off');
}

// Keyboard shortcuts: F fold · K check · C call · R raise · A all-in · Enter/Esc in raise panel
document.addEventListener('keydown', e => {
  const onGame = document.querySelector('.screen.active');
  if (!onGame || onGame.id !== 's-game') return;
  if (!lastState) return;
  const me = lastState.seats && lastState.seats.find(s => s && s.isYou);
  if (!me || !me.isTurn || lastState.over) return;
  const raiseOpen = !document.getElementById('abar-raise').classList.contains('hidden');
  const typing = ['INPUT','SELECT','TEXTAREA'].includes((e.target.tagName||''));

  if (raiseOpen) {
    if (e.key === 'Enter') { e.preventDefault(); confirmRaise(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeRaise(); }
    return;
  }
  if (typing) return;
  const k = e.key.toLowerCase();
  const enabled = id => { const b = document.getElementById(id); return b && !b.disabled; };
  const canCheck = enabled('btn-check');
  if (k === 'f') { e.preventDefault(); send('fold'); }
  else if (k === 'k' && canCheck) { e.preventDefault(); send('check'); }
  // C = call when facing a bet; when nobody has bet yet, C makes the minimum bet
  else if (k === 'c') { e.preventDefault(); if (enabled('btn-call')) send('call'); else if (canCheck) minRaise(); }
  else if (k === 'm') { e.preventDefault(); minRaise(); }          // M = instant minimum raise/bet
  else if (k === 'r' && enabled('btn-raise-open')) { e.preventDefault(); openRaise(); }
  else if (k === 'a' && me.chips > 0) { e.preventDefault(); send('allin'); }
});

// Fire an immediate minimum-legal raise/bet (no panel).
function minRaise() {
  if (!raiseCtx) return;
  document.getElementById('rslider').value = raiseCtx.lo;
  send('raise');
  showRaisePanel(false);
}

function endSession() {
  if (!socket || !roomCode) return;
  if (!confirm('End the session and see everyone\'s stats?')) return;
  socket.emit('end_session', { code: roomCode });
}

function setThink(t) {
  const el = document.getElementById('think');
  el.textContent = t;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.textContent = '', 300); }, 3000);
}


// ── RESULTS (your own detailed stats + a shared leaderboard) ──
function buildResults(you, leaderboard, handNum) {
  const top = leaderboard[0];
  document.getElementById('res-sub').textContent = handNum + ' hands played · '
    + (top.name === you.name ? 'you finished on top 🏆' : top.name + ' finished on top');
  window.__hl = you.stat.handLog || []; // for the clickable range grid
  buildLB(leaderboard, you.name);
  const grid = document.getElementById('res-grid');
  grid.innerHTML = '';
  grid.appendChild(buildPC(you)); // only your own detailed breakdown
}

function gtoAcc(stat) {
  if (!stat.gtoDecisions || !stat.gtoDecisions.length) return 0;
  return Math.round(stat.gtoDecisions.filter(d => d.correct).length / stat.gtoDecisions.length * 100);
}

function buildLB(players, youName) {
  const medals = ['🥇','🥈','🥉'];
  const max = Math.max(...players.map(p => p.chips)) || 1;
  let html = '<h3>🏆 Final standings</h3>';
  players.forEach((p, i) => {
    const net = p.net, netCls = net > 0 ? 'pos' : net < 0 ? 'neg' : 'neu';
    const wr = p.handsPlayed ? Math.round(p.wins / p.handsPlayed * 100) : 0;
    html += '<div class="pod-row' + (p.name === youName ? ' lb-you' : '') + '">'
      + '<div class="pod-pos">' + (medals[i] || '#' + (i+1)) + '</div>'
      + '<div class="pod-main"><div class="pod-name">' + esc(p.name) + (p.name === youName ? ' <span class="lb-youtag">YOU</span>' : '') + '</div>'
      + '<div class="pod-bar"><div class="pod-bar-f" style="width:' + Math.round(p.chips / max * 100) + '%"></div></div></div>'
      + '<div class="pod-meta"><div class="pod-chips">' + p.chips + '</div><div class="pod-sub">' + wr + '% won · 🏆' + p.wins + '</div></div>'
      + '<div class="pod-net ' + netCls + '">' + (net > 0 ? '+' : '') + net + '</div>'
      + '</div>';
  });
  document.getElementById('res-lb').innerHTML = html;
}

// Detail panel for a clicked range-grid cell.
function showCombo(combo) {
  const el = document.getElementById('rg-detail'); if (!el) return;
  const hands = (window.__hl || []).filter(h => h.combo === combo);
  if (!hands.length) { el.innerHTML = '<div class="rgd-empty">' + combo + ' — not dealt this session</div>'; return; }
  el.innerHTML = '<div class="rgd-t">' + combo + ' · ' + hands.length + ' hand' + (hands.length > 1 ? 's' : '') + '</div>'
    + hands.map(h => {
      const cards = h.cards.map(c => cardHTML(c, 'xs')).join('');
      const board = (h.board || []).map(c => cardHTML(c, 'xs')).join('');
      const res = h.won ? '<span class="hh-res hw">+' + h.winAmt + '</span>' : h.folded ? '<span class="hh-res hf">Fold</span>' : '<span class="hh-res hl">Lost</span>';
      return '<div class="rgd-row"><span class="rgd-act ' + h.pfAction + '">' + h.pfAction + '</span>'
        + '<span class="rgd-cards">' + cards + (board ? '<span class="mk-sep">/</span>' + board : '') + '</span>' + res + '</div>';
    }).join('');
}

// 13×13 starting-hand grid showing how the player actually played each combo preflop.
const RANKS13 = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
const ACT_COL = { raise:'#c9a84c', call:'#46d27c', check:'#5aa9e6', fold:'rgba(255,255,255,.07)' };
function buildRangeGrid(handLog) {
  const map = {};
  handLog.forEach(h => {
    if (!h.combo) return;
    const a = h.pfAction || 'fold';
    (map[h.combo] = map[h.combo] || {})[a] = (map[h.combo][a] || 0) + 1;
  });
  const pick = combo => {
    const m = map[combo]; if (!m) return null;
    let best = null, bc = -1;
    ['raise','call','check','fold'].forEach(a => { if ((m[a]||0) > bc) { bc = m[a]||0; best = a; } });
    return best;
  };
  let cells = '';
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    const combo = i === j ? RANKS13[i] + RANKS13[j] : i < j ? RANKS13[i] + RANKS13[j] + 's' : RANKS13[j] + RANKS13[i] + 'o';
    const a = pick(combo);
    cells += '<div class="rg-c' + (a ? ' rg-played' : '') + '" style="' + (a ? 'background:' + ACT_COL[a] : '') + '"'
      + (a ? ' onclick="showCombo(\'' + combo + '\')"' : '') + ' title="' + combo + (a ? ' · ' + a + ' (click)' : '') + '">' + combo + '</div>';
  }
  return '<div class="rg-wrap"><div class="rg-t">Your preflop play — tap a hand to see it</div>'
    + '<div class="rg-grid">' + cells + '</div>'
    + '<div class="rg-legend">'
    + '<span><i style="background:#c9a84c"></i>Raise</span><span><i style="background:#46d27c"></i>Call</span>'
    + '<span><i style="background:#5aa9e6"></i>Check</span><span><i style="background:rgba(255,255,255,.12)"></i>Fold / not dealt</span>'
    + '</div><div id="rg-detail"></div></div>';
}

// circular accuracy gauge with a letter grade
function gtoGauge(acc) {
  const grade = acc >= 85 ? 'A+' : acc >= 75 ? 'A' : acc >= 65 ? 'B' : acc >= 55 ? 'C' : acc >= 45 ? 'D' : 'F';
  const col = acc >= 70 ? '#2ecc71' : acc >= 50 ? '#e8cc7a' : '#e74c3c';
  const r = 42, C = 2 * Math.PI * r, off = C * (1 - acc / 100);
  return '<svg class="gauge" viewBox="0 0 100 100">'
    + '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="9"/>'
    + '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + C + '" stroke-dashoffset="' + off + '" transform="rotate(-90 50 50)"/>'
    + '<text x="50" y="48" text-anchor="middle" class="gauge-grade" fill="' + col + '">' + grade + '</text>'
    + '<text x="50" y="66" text-anchor="middle" class="gauge-pct">' + acc + '%</text></svg>';
}

function buildPC(p) {
  const s = p.stat;
  const net = p.chips - s.startChips;
  const wr = s.handsPlayed ? Math.round(s.handsWon / s.handsPlayed * 100) : 0;
  const luck = s.luckDen ? Math.round(50 + 50 * (s.luckNum / s.luckDen)) : 50;
  const luckChips = Math.round(s.luckChips || 0);
  const luckLbl = luck >= 70 ? 'Heater 🔥' : luck >= 58 ? 'Run-good 🍀' : luck >= 43 ? 'Fair ⚖️' : luck >= 30 ? 'Bit cold 🥶' : 'Brutal 💀';
  const vp = s.handsPlayed ? Math.round(s.vpip / s.handsPlayed * 100) : 0;
  const fr = s.handsPlayed ? Math.round(s.folds / s.handsPlayed * 100) : 0;
  const gto = gtoAcc(s);
  const gtoCls = gto >= 70 ? 'g' : gto >= 50 ? 'n' : 'r';
  const gtoLbl = gto >= 75 ? 'Solver-approved 🎯' : gto >= 60 ? 'Solid fundamentals 👍' : gto >= 45 ? 'Some leaks to plug 🔧' : 'Spew alert 🚨';
  const gtoCol = gto >= 70 ? '#2ecc71' : gto >= 50 ? '#e8cc7a' : '#e74c3c';
  const inits = p.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const netCls = net > 0 ? 'pos' : net < 0 ? 'neg' : 'neu';

  const card = document.createElement('div');
  card.className = 'pc';
  let html = '<div class="pc-head">'
    + '<div class="pc-init">' + inits + '</div>'
    + '<div><div class="pc-nm">' + p.name + '</div></div>'
    + '<div class="pc-netval ' + netCls + '">' + (net > 0 ? '+' : '') + net + '</div>'
    + '</div><div class="pc-body"><div class="pc-stats">'
    + '<div class="ps"><div class="ps-l">Final chips</div><div class="ps-v ' + (net>0?'g':net<0?'r':'') + '">' + p.chips + '</div></div>'
    + '<div class="ps"><div class="ps-l">Win rate</div><div class="ps-v ' + (wr>=40?'g':wr>=25?'n':'r') + '">' + wr + '%</div></div>'
    + '<div class="ps"><div class="ps-l">VPIP</div><div class="ps-v n">' + vp + '%</div></div>'
    + '<div class="ps"><div class="ps-l">Fold rate</div><div class="ps-v">' + fr + '%</div></div>'
    + '<div class="ps"><div class="ps-l">Ghost wins</div><div class="ps-v n">' + (s.ghostWins||0) + '</div></div>'
    + '<div class="ps"><div class="ps-l">Luck · ' + luckLbl + '</div><div class="ps-v n">' + luck
    + '<span style="font-size:11px;color:rgba(255,255,255,.35)"> (' + (luckChips>0?'+':'') + luckChips + ' vs EV)</span></div>'
    + '<div class="luck-row"><div class="luck-t"><div class="luck-f" style="width:' + Math.min(luck,100) + '%"></div></div></div></div>'
    + '</div></div>';

  // GTO
  if (s.gtoDecisions && s.gtoDecisions.length) {
    html += '<div class="gto-wrap"><div class="gto-t">GTO report card</div>'
      + '<div class="gto-hero">' + gtoGauge(gto)
      + '<div class="gto-hero-txt"><div class="gto-grade-lbl ' + gtoCls + '">' + gtoLbl + '</div>'
      + '<div class="gto-sub">' + s.gtoDecisions.length + ' decisions analysed</div></div></div>';
    // per-street accuracy
    html += '<div class="gto-streetacc">' + ['preflop','flop','turn','river'].map(st => {
      const ds = s.gtoDecisions.filter(d => d.street === st);
      if (!ds.length) return '';
      const a = Math.round(ds.filter(d => d.correct).length / ds.length * 100);
      const col = a >= 70 ? '#2ecc71' : a >= 50 ? '#e8cc7a' : '#e74c3c';
      return '<div class="gsa"><div class="gsa-l">' + st + '</div><div class="gsa-v" style="color:' + col + '">' + a + '%</div></div>';
    }).join('') + '</div>';
    html += '</div>';

    // Biggest leaks — your worst decisions, with the hand + board shown
    const byHand = {}; (s.handLog || []).forEach(h => byHand[h.num] = h);
    const mistakes = s.gtoDecisions.filter(d => !d.correct).slice(-5).reverse();
    html += '<div class="mk-wrap"><div class="mk-t">🔍 Biggest leaks</div>';
    if (!mistakes.length) {
      html += '<div class="mk-empty">No major leaks — clean session! 🎉</div>';
    } else {
      mistakes.forEach(d => {
        const hl = byHand[d.hand] || { cards: [], board: [] };
        const n = d.street === 'preflop' ? 0 : d.street === 'flop' ? 3 : d.street === 'turn' ? 4 : 5;
        const cards = (hl.cards || []).map(c => cardHTML(c, 'xs')).join('');
        const board = (hl.board || []).slice(0, n).map(c => cardHTML(c, 'xs')).join('');
        const badge = d.equity != null ? d.equity + '% eq' : (d.chen != null ? 'Chen ' + d.chen : '');
        html += '<div class="mk-row"><div class="mk-cards">' + cards + (board ? '<span class="mk-sep">/</span>' + board : '') + '</div>'
          + '<div class="mk-body"><div class="mk-st">' + d.street + ' · ' + d.action + '</div><div class="mk-note">' + d.note + '</div></div>'
          + (badge ? '<div class="gto-badge">' + badge + '</div>' : '') + '</div>';
      });
    }
    html += '</div>';
  }

  // Preflop range grid (clickable — replaces the old hand-history list)
  html += buildRangeGrid(s.handLog || []);

  // Profit curve
  html += '<div class="chart-wrap"><div class="chart-t">Profit curve</div>'
    + '<canvas id="ch-' + p.name.replace(/[^a-z0-9]/gi,'_') + '" style="width:100%;height:72px;display:block"></canvas>'
    + '</div>';

  card.innerHTML = html;
  setTimeout(() => drawChart('ch-' + p.name.replace(/[^a-z0-9]/gi,'_'), s.chipHistory), 80);
  return card;
}

// Profit curve: net chips vs the starting stack, zero baseline, green up / red down, hover tooltip.
function drawChart(id, data) {
  const c = document.getElementById(id);
  if (!c || !data || data.length < 2) return;
  const start = data[0], net = data.map(v => v - start);
  c.width = c.offsetWidth || 300; c.height = 72;
  const ctx = c.getContext('2d'), w = c.width, h = c.height;
  const mn = Math.min(0, ...net), mx = Math.max(0, ...net), rng = (mx - mn) || 1;
  const sx = i => (i / (net.length - 1)) * (w - 6) + 3;
  const sy = v => h - 5 - ((v - mn) / rng) * (h - 12);
  const y0 = sy(0), finalNet = net[net.length - 1];
  const up = finalNet >= 0, line = up ? '#2ecc71' : '#e74c3c';
  function render(hi) {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(w, y0); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(sx(0), sy(net[0]));
    net.forEach((v, i) => ctx.lineTo(sx(i), sy(v)));
    ctx.lineTo(sx(net.length - 1), y0); ctx.lineTo(sx(0), y0); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    if (up) { g.addColorStop(0, 'rgba(46,204,113,.3)'); g.addColorStop(1, 'rgba(46,204,113,.02)'); }
    else { g.addColorStop(0, 'rgba(231,76,60,.04)'); g.addColorStop(1, 'rgba(231,76,60,.3)'); }
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.moveTo(sx(0), sy(net[0]));
    net.forEach((v, i) => ctx.lineTo(sx(i), sy(v)));
    ctx.strokeStyle = line; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
    if (hi != null) {
      ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.beginPath(); ctx.moveTo(sx(hi), 0); ctx.lineTo(sx(hi), h); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx(hi), sy(net[hi]), 3, 0, 7); ctx.fill();
    }
  }
  render(null);
  let tip = document.getElementById('chart-tip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'chart-tip'; document.body.appendChild(tip); }
  c.onmousemove = ev => {
    const r = c.getBoundingClientRect();
    let i = Math.round(((ev.clientX - r.left) - 3) / (w - 6) * (net.length - 1));
    i = Math.max(0, Math.min(net.length - 1, i)); render(i);
    const v = net[i]; tip.textContent = 'Hand ' + i + ': ' + (v >= 0 ? '+' : '') + v;
    tip.style.left = (ev.clientX + 12) + 'px'; tip.style.top = (ev.clientY - 8) + 'px'; tip.style.opacity = '1';
  };
  c.onmouseleave = () => { render(null); if (tip) tip.style.opacity = '0'; };
}

// ── UTILS ──
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}
function newSession() { showScreen('s-lobby'); }

// Auto-join from URL
window.addEventListener('load', () => {
  const mb = document.getElementById('btn-mute'); if (mb) mb.textContent = sfx.muted ? '🔇' : '🔊';
  const m = window.location.pathname.match(/\/room\/([A-Z0-9]{6})/i);
  if (m) {
    document.getElementById('j-code').value = m[1].toUpperCase();
    switchTab('join');
  }
});
