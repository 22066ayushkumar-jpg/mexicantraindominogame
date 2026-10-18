/* Mexican Train Dominoes — UI controller (vanilla JS, no dependencies) */
(function () {
  'use strict';
  var E = window.MTEngine;
  if (!E) return;

  /* ---------------- persistence ---------------- */
  var LS = {
    settings: 'mtd.settings.v1', save: 'mtd.save.v1', stats: 'mtd.stats.v1',
    theme: 'mtd.theme.v1', sound: 'mtd.sound.v1'
  };
  function lsGet(k, fallback) {
    try { var v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  var settings = Object.assign({ setMax: 12, opponents: 3, humans: 1, diff: 'medium', rounds: 3, fast: false }, lsGet(LS.settings, {}));
  var stats = Object.assign({ games: 0, wins: 0, best: null }, lsGet(LS.stats, {}));

  /* ---------------- tiny synth sfx ---------------- */
  var Sfx = {
    enabled: lsGet(LS.sound, true) !== false,
    ctx: null,
    ensure: function () {
      if (!this.ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { try { this.ctx = new AC(); } catch (e) {} }
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone: function (f, dur, type, gain, delay) {
      var c = this.ctx; if (!c) return;
      var t = c.currentTime + (delay || 0);
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain || 0.12, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + dur + 0.05);
    },
    suspend: function () { if (this.ctx && this.ctx.state === 'running') { try { this.ctx.suspend(); } catch (e) {} } },
    resume: function () { if (this.ctx && this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) {} } },
    play: function (name) {
      if (!this.enabled) return;
      if (!this.ensure()) return;
      switch (name) {
        case 'place': this.tone(540, 0.09, 'triangle', 0.14); this.tone(720, 0.07, 'sine', 0.09, 0.03); break;
        case 'draw': this.tone(300, 0.08, 'sine', 0.08); break;
        case 'double': this.tone(660, 0.1, 'square', 0.06); this.tone(880, 0.12, 'square', 0.06, 0.08); break;
        case 'open': this.tone(420, 0.14, 'sawtooth', 0.05); this.tone(310, 0.18, 'sawtooth', 0.05, 0.1); break;
        case 'win': [523, 659, 784, 1047].forEach(function (f, i) { Sfx.tone(f, 0.16, 'triangle', 0.12, i * 0.09); }); break;
        case 'bad': this.tone(180, 0.14, 'square', 0.05); break;
      }
    }
  };
  var buzzReady = false;
  function armBuzz() {
    if (buzzReady) return;
    buzzReady = true;
    window.removeEventListener('pointerdown', armBuzz);
    window.removeEventListener('keydown', armBuzz);
    window.removeEventListener('touchstart', armBuzz);
  }
  window.addEventListener('pointerdown', armBuzz);
  window.addEventListener('keydown', armBuzz);
  window.addEventListener('touchstart', armBuzz);
  function buzz(ms) { if (!buzzReady) return; try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }
  function tap() { buzz(10); } // light haptic tick for every HUD press
  var paused = false;

  /* ---------------- domino rendering ---------------- */
  var PIPS = { 0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function halfEl(v, vert) {
    var d = document.createElement('span');
    d.className = 'half';
    if (PIPS.hasOwnProperty(v)) {
      PIPS[v].forEach(function (idx) {
        var p = document.createElement('i'); p.className = 'pip';
        p.style.gridArea = (Math.floor(idx / 3) + 1) + ' / ' + ((idx % 3) + 1);
        d.appendChild(p);
      });
    } else {
      var n = document.createElement('b'); n.className = 'num'; n.textContent = v;
      n.setAttribute('aria-hidden', 'true'); // digits are decorative; the tile's aria-label names it
      d.appendChild(n);
    }
    return d;
  }
  function dominoEl(a, b, opts) {
    opts = opts || {};
    var el = document.createElement(opts.button ? 'button' : 'div');
    el.className = 'domino' + (opts.big ? ' big' : '') + (opts.vert ? ' vert' : '') +
      (opts.back ? ' back' : '') + (opts.dblPerp ? ' dbl-perp' : '') +
      (opts.extraClass ? ' ' + opts.extraClass : '');
    if (opts.dblPerp) {
      el.appendChild(halfEl(a)); el.appendChild(halfEl(b));
    } else if (opts.vert) {
      el.appendChild(halfEl(a)); el.appendChild(halfEl(b));
    } else {
      el.appendChild(halfEl(opts.leftView !== undefined ? opts.leftView : a));
      el.appendChild(halfEl(opts.leftView !== undefined ? (opts.leftView === a ? b : a) : b));
    }
    if (opts.label) el.setAttribute('aria-label', opts.label);
    if (opts.button) el.type = 'button';
    return el;
  }
  function trainName(key) {
    if (key === 'M') return 'the Mexican Train';
    var owner = +key;
    if (owner === 0) return singleHuman ? 'your train' : (state.players[0].name + "'s train");
    return (state.players[owner] ? state.players[owner].name : 'player') + "'s train";
  }

  /* ---------------- dom refs ---------------- */
  function $(id) { return document.getElementById(id); }
  var P_COLORS = ['#4fb677', '#e05c5c', '#e0a23f', '#5a8fd6']; // you, then opponents

  var el = {
    board: $('board'), engineTile: $('engine-tile'), oppRows: $('opponent-rows'),
    myZone: $('my-train-zone'), myName: $('my-train-name'), myOpen: $('my-open-tag'),
    trainM: $('train-M'), train0: $('train-0'),
    hand: $('hand'), handTitle: $('hand-title'),
    btnDraw: $('btn-draw'), btnPass: $('btn-pass'), hintBar: $('hint-bar'),
    statusRound: $('status-round'), statusBoneyard: $('status-boneyard'), statusTurn: $('status-turn'),
    btnUndo: $('btn-undo'), btnHint: $('btn-hint'), btnSort: $('btn-sort'), btnNew: $('btn-newgame'),
    btnSound: $('btn-sound'), btnTheme: $('btn-theme'), btnHelp: $('btn-help'),
    passGate: $('pass-gate'), passGateTitle: $('pass-gate-title'), passGateText: $('pass-gate-text'),
    passGateReady: $('pass-gate-ready'),
    modalRound: $('modal-round'), roundTitle: $('round-title'), roundTable: $('round-table'), roundNext: $('round-next'),
    modalEnd: $('modal-end'), endTitle: $('end-title'), endTable: $('end-table'), endStats: $('end-stats'),
    endAgain: $('end-again'), endSettings: $('end-settings'),
    modalSettings: $('modal-settings'), settingsForm: $('settings-form'),
    setSetmax: $('set-setmax'), setPlayers: $('set-players'), setHumans: $('set-humans'),
    setDiff: $('set-diff'), setRounds: $('set-rounds'), setFast: $('set-fast'),
    settingsStart: $('settings-start'), settingsCancel: $('settings-cancel'),
    modalHelp: $('modal-help'), helpClose: $('help-close'),
    toasts: $('toasts'),
    byBtn: $('boneyard'), byCount: $('boneyard-count'),
    handZone: document.querySelector('.hand-zone'),
    shell: $('game'), statusBest: $('status-best'),
    btnFS: $('btn-fullscreen'), btnPause: $('btn-pause'),
    modalPause: $('modal-pause'), pauseStats: $('pause-stats'),
    pauseResume: $('pause-resume'), pauseNew: $('pause-new'), pauseHelp: $('pause-help'),
    pauseSound: $('pause-sound'), pauseTheme: $('pause-theme'), pauseFS: $('pause-fullscreen')
  };

  /* ---------------- game state ---------------- */
  var state = null, undoStack = [], selectedTileId = null, busy = false, aiTimer = null;
  var lastLogPos = 0, lastGateTurn = -1, lastHintTimer = null, lastMoveTrainKey = null;
  var singleHuman = settings.humans === 1;

  function aiNames(n, startIdx) {
    var names = ['Rusty', 'Tess', 'Dilly', 'Spike'];
    var out = [];
    for (var i = 0; i < n; i++) out.push(names[(startIdx + i) % names.length]);
    return out;
  }

  function startNewGame() {
    var total = settings.opponents + 1;
    var humans = Math.max(1, Math.min(settings.humans, total));
    singleHuman = humans === 1;
    var names = [], i;
    if (singleHuman) {
      names = ['You'].concat(aiNames(total - 1, 0));
    } else {
      var aiCount = total - humans;
      var ais = aiNames(aiCount, 0);
      for (i = 0; i < total; i++) names.push(i < humans ? 'Player ' + (i + 1) : 'Computer ' + (i - humans + 1));
    }
    var diffs = [];
    for (i = 0; i < total; i++) diffs.push(i < humans ? null : settings.diff);
    state = E.newGame({
      setMax: settings.setMax, playerCount: total, humans: humans,
      rounds: settings.rounds, names: names, diffs: diffs
    });
    undoStack = []; selectedTileId = null; busy = false; lastLogPos = state.log.length;
    lastGateTurn = -1; lastMoveTrainKey = null;
    el.modalRound.hidden = true; el.modalEnd.hidden = true; el.modalSettings.hidden = true; el.passGate.hidden = true;
    el.board.dataset.set = String(settings.setMax);
    el.shell.removeAttribute('data-fit');
    chunkedSig = null;
    saveGame();
    render();
    toast('Round 1 — ' + state.players[state.turn].name + ' starts with the ' + state.engine.a + '|' + state.engine.b + ' engine', 'good');
    kick();
  }

  function saveGame() {
    if (!state) return;
    lsSet(LS.save, { v: 1, state: state, settingsName: singleHuman ? 'solo' : 'party' });
  }

  /* ---------------- toasts / sfx hooks ---------------- */
  function toast(msg, kind, ms) {
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    el.toasts.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 2600);
    while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
  }
  function announceNewLog() {
    for (var i = lastLogPos; i < state.log.length; i++) {
      var e = state.log[i];
      switch (e.type) {
        case 'double': toast('Double ' + e.val + '|' + e.val + ' — it must be covered!', 'warn'); Sfx.play('double'); buzz(20); break;
        case 'cover': toast(state.players[e.player].name + ' covers the double'); Sfx.play('place'); break;
        case 'open': toast(state.players[e.player].name + (singleHuman && e.player === 0 ? 'r train is open' : "'s train is open"), 'warn'); Sfx.play('open'); break;
        case 'out': toast(state.players[e.player].name + (e.player === 0 && singleHuman ? ' domino — you played all your tiles!' : ' played their last domino!'), 'good'); Sfx.play('win'); break;
        case 'blocked': toast('All players are blocked — round ends', 'warn'); break;
        case 'pendingReleased': toast('Nobody could cover the double — play continues', 'warn'); break;
        case 'play': if (!e.double) { Sfx.play('place'); buzz(8); } break;
      }
    }
    lastLogPos = state.log.length;
  }

  /* ---------------- rendering ---------------- */
  function render() {
    if (!state) return;
    try {
      renderInner();
      chunkedSig = currentChunkSig(); // rows now match this tier's piece size
    } catch (err) {
      // one retry: a second failure usually clears transient DOM state
      try { renderInner(); chunkedSig = currentChunkSig(); } catch (e2) { try { restoreSave(); } catch (e3) {} }
      return;
    }
  }

  function renderInner() {
    var i, k;
    // top bar
    el.statusRound.textContent = 'Round ' + state.round + ' of ' + state.cfg.rounds;
    el.statusBoneyard.textContent = 'Boneyard: ' + state.boneyard.length;
    if (el.byCount) el.byCount.textContent = String(state.boneyard.length);
    if (el.statusBest) {
      var showBest = singleHuman && stats.best !== null && stats.best !== undefined;
      el.statusBest.hidden = !showBest;
      if (showBest) el.statusBest.textContent = '★ Best ' + stats.best;
    }
    var cur = state.players[state.turn];
    if (state.phase === 'play') {
      el.statusTurn.textContent = cur.isAI ? (cur.name + ' is thinking…') : (singleHuman ? 'Your turn' : cur.name + "'s turn");
      el.statusTurn.className = 'pill turn-pill ' + (cur.isAI ? 'ai-turn' : 'on-turn');
    } else {
      el.statusTurn.textContent = state.phase === 'roundEnd' ? 'Round over' : 'Game over';
      el.statusTurn.className = 'pill turn-pill';
    }

    // engine hub
    el.engineTile.innerHTML = '';
    el.engineTile.appendChild(dominoEl(state.engine.a, state.engine.b, { vert: true, big: true, label: 'Engine double ' + state.engine.a + ' by ' + state.engine.b }));

    // trains
    renderTrainInto(el.trainM, 'M');
    renderTrainInto(el.train0, '0');
    el.myName.textContent = singleHuman ? 'Your train' : state.players[0].name + "'s train";
    el.myOpen.hidden = !state.players[0].open;

    // player accents
    el.myZone.style.setProperty('--pc', P_COLORS[0]);
    if (el.handZone) el.handZone.style.setProperty('--pc', P_COLORS[currentHumanIdx() % 4]);

    // opponent rows
    el.oppRows.innerHTML = '';
    for (i = 1; i < state.cfg.playerCount; i++) {
      var row = document.createElement('div');
      row.className = 'opp-row' + (state.turn === i && state.phase === 'play' ? ' active-turn' : '');
      row.dataset.p = String(i);
      row.style.setProperty('--pc', P_COLORS[i % 4]);
      var meta = document.createElement('div'); meta.className = 'opp-meta';
      var nm = document.createElement('div'); nm.className = 'opp-name';
      var dot = document.createElement('span'); dot.className = 'dot';
      dot.style.background = P_COLORS[i % 4];
      nm.appendChild(dot);
      nm.appendChild(document.createTextNode(state.players[i].name + (state.players[i].isAI ? '' : ' 🖐')));
      meta.appendChild(nm);
      var sub = document.createElement('div'); sub.className = 'opp-sub';
      sub.appendChild(chip(state.players[i].hand.length + ' tiles'));
      if (state.players[i].score > 0 || state.round > 1) sub.appendChild(chip(state.players[i].score + ' pts', 'score'));
      if (state.players[i].open) sub.appendChild(chip('OPEN', 'open-chip'));
      meta.appendChild(sub);
      row.appendChild(meta);
      var strip = document.createElement('div');
      strip.className = 'train-strip'; strip.dataset.train = String(i);
      row.appendChild(strip);
      el.oppRows.appendChild(row);
      renderTrainInto(strip, String(i)); // after attach so clientWidth is real
    }

    // active-turn highlight for my row
    el.myZone.classList.toggle('active-turn', state.turn === 0 && state.phase === 'play');

    renderHand();
    renderButtons();
    announceNewLog();
    scheduleFit(); // re-check the fold after board changes (trains grow)
  }

  function chip(txt, kind) {
    var c = document.createElement('span');
    c.className = 'opp-chip' + (kind ? ' ' + kind : '');
    c.textContent = txt;
    return c;
  }

  function trainTileW() {
    // read from the shell itself: fit tiers override --train-h on .game-shell
    var h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--train-h')) || 30;
    if (state && el.shell) h = parseFloat(getComputedStyle(el.shell).getPropertyValue('--train-h')) || h;
    return h * 1.52 + 3; // horizontal domino width + gap
  }

  // Serpentine wrap: row 0 reads left→right, row 1 right→left (tiles mirrored so pips
  // keep flowing), etc. The open end + play button always stay on screen — no scrolling.
  function renderTrainInto(stripEl, key) {
    stripEl.innerHTML = '';
    stripEl.dataset.train = key;
    var tr = state.trains[key] || [];
    var pend = state.pending && state.pending.train === key ? state.pending : null;

    var rowsBox = document.createElement('div');
    rowsBox.className = 'train-rows';
    stripEl.appendChild(rowsBox);

    var avail = Math.max(120, (stripEl.clientWidth || stripEl.parentElement && stripEl.parentElement.clientWidth || 320) - 20);
    var perRow = Math.max(2, Math.floor((avail - 40) / trainTileW())); // reserve a slot for the end button
    stripEl.dataset.perRow = String(perRow);

    var items = [];
    for (var i = 0; i < tr.length; i++) items.push(tr[i]);
    var endBtn = document.createElement('button');
    endBtn.type = 'button';
    endBtn.className = 'end-btn';
    endBtn.dataset.train = key;
    endBtn.textContent = '+';
    endBtn.addEventListener('click', onEndpoint);
    items.push({ btn: endBtn });

    var rows = [];
    for (i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
    if (!rows.length) rows.push([items[0]]);

    for (i = 0; i < rows.length; i++) {
      var rev = i % 2 === 1;
      var row = document.createElement('div');
      row.className = 'train-row' + (rev ? ' rev' : '');
      if (i === 0 && tr.length === 0) {
        var note = document.createElement('span');
        note.className = 'train-empty-note';
        note.textContent = key === 'M' ? 'starts from the engine — anyone can build here' : 'not started yet';
        row.appendChild(note);
      }
      rows[i].forEach(function (it) {
        if (it.btn) { row.appendChild(it.btn); return; }
        var p = it;
        if (p.double) {
          var d = dominoEl(p.a, p.b, { dblPerp: true, extraClass: (pend && pend.tileId === p.tileId) ? 'unsatisfied' : '' });
          row.appendChild(d);
          if (p.coverTile) {
            var cv = dominoEl(p.coverTile.a, p.coverTile.b, { dblPerp: true, extraClass: 'cover-tile' });
            cv.title = 'covers the double';
            row.appendChild(cv);
          }
        } else {
          var leftView = rev ? (p.flipped ? p.a : p.b) : (p.flipped ? p.b : p.a);
          row.appendChild(dominoEl(p.a, p.b, { leftView: leftView }));
        }
      });
      rowsBox.appendChild(row);
    }
  }

  function currentHumanIdx() {
    if (singleHuman) return 0;
    return state.turn;
  }

  function renderHandTiles(pl, interactive, isPlayable) {
    pl.hand.forEach(function (t) {
      var playable = isPlayable && isPlayable(t);
      var classes = [];
      if (playable && interactive) classes.push('playable');
      if (t.id === selectedTileId) classes.push('selected');
      var d = dominoEl(t.a, t.b, {
        big: true, button: true, extraClass: classes.join(' '),
        label: 'Domino ' + t.a + ' ' + t.b + (playable ? ' — playable' : '')
      });
      d.dataset.tileId = String(t.id);
      d.addEventListener('click', onTileTap);
      el.hand.appendChild(d);
    });
  }

  function renderHand() {
    el.hand.innerHTML = '';
    var hIdx = currentHumanIdx();
    var pl = state.players[hIdx];
    var isCurHumanTurn = state.phase === 'play' && !state.players[state.turn].isAI;
    el.handTitle.textContent = singleHuman
      ? 'Your dominoes (' + pl.hand.length + ') — ' + E.pips(pl.hand) + ' pips'
      : (pl.name + "'s dominoes (" + pl.hand.length + ')');
    if (state.phase !== 'play') {
      renderHandTiles(pl, false, false);
      el.hintBar.textContent = state.phase === 'roundEnd' ? 'Round complete — see the summary.' : 'Game over — start a new game whenever you like.';
      el.hintBar.className = 'hint-bar';
      return;
    }
    if (state.players[state.turn].isAI) {
      renderHandTiles(pl, false, false);
      el.hintBar.textContent = curText();
      el.hintBar.className = 'hint-bar';
      return;
    }
    var moves = E.legalMoves(state);
    var movTypes = {};
    moves.forEach(function (m) { movTypes[m.t] = (movTypes[m.t] || 0) + 1; });

    var playableIds = {};
    moves.forEach(function (m) { if (m.tileId !== undefined) playableIds[m.tileId] = true; });
    renderHandTiles(pl, isCurHumanTurn, function (t) { return !!playableIds[t.id]; });

    // hint bar guidance
    if (moves.length && moves[0].t === 'cover') {
      el.hintBar.textContent = 'Cover the double ' + state.pending.val + '|' + state.pending.val + ': tap a matching domino, then the gold slot.';
      el.hintBar.className = 'hint-bar bad-pips';
    } else if (movTypes.draw) {
      el.hintBar.textContent = state.pending ? 'No matching domino — draw from the boneyard to try to cover the double.' : 'No playable domino — draw one from the boneyard.';
      el.hintBar.className = 'hint-bar';
    } else if (movTypes.failCover) {
      el.hintBar.textContent = 'You cannot cover the double — your train will be marked open.';
      el.hintBar.className = 'hint-bar bad-pips';
    } else if (movTypes.pass) {
      el.hintBar.textContent = 'Boneyard is empty and nothing fits — pass (your train will be marked open).';
      el.hintBar.className = 'hint-bar';
    } else {
      el.hintBar.textContent = singleHuman ? 'Tap a glowing domino, then tap a train end.' : 'Tap a glowing domino, then tap a train end.';
      el.hintBar.className = 'hint-bar';
    }
  }

  function curText() {
    var c = state.players[state.turn];
    return c.isAI ? c.name + ' is taking their turn…' : '';
  }

  function movesForSelected() {
    if (selectedTileId === null) return [];
    return E.legalMoves(state).filter(function (m) {
      return (m.t === 'play' || m.t === 'cover') && m.tileId === selectedTileId;
    });
  }

  function renderButtons() {
    var humanTurn = state.phase === 'play' && !state.players[state.turn].isAI;
    var moves = humanTurn ? E.legalMoves(state) : [];
    var t0 = moves[0] || null;
    el.btnDraw.hidden = !(humanTurn && t0 && t0.t === 'draw');
    if (!el.btnDraw.hidden) el.btnDraw.textContent = state.pending ? 'Draw — try to cover the double' : 'Draw from boneyard';
    if (el.byBtn) el.byBtn.classList.toggle('can-draw', !el.btnDraw.hidden);
    el.btnPass.hidden = !(humanTurn && t0 && (t0.t === 'pass' || t0.t === 'failCover'));
    if (!el.btnPass.hidden) el.btnPass.textContent = t0.t === 'failCover' ? "Can't cover — open train & pass" : 'Pass — open your train';

    el.btnUndo.disabled = !singleHuman || busy || undoStack.length === 0 || state.players[state.turn].isAI || state.phase !== 'play';
    el.btnHint.disabled = busy || !humanTurn || state.phase !== 'play';
    el.btnSort.disabled = busy || !humanTurn || state.phase !== 'play';

    // endpoint visibility for selected tile
    var opts = humanTurn ? movesForSelected() : [];
    var trainsWithOptions = {};
    opts.forEach(function (m) {
      var key = m.t === 'cover' ? state.pending.train : m.train;
      trainsWithOptions[key] = trainsWithOptions[key] || [];
      trainsWithOptions[key].push(m);
    });
    document.querySelectorAll('.end-btn').forEach(function (b) {
      var key = b.dataset.train;
      var list = trainsWithOptions[key];
      if (humanTurn && list && list.length) {
        b.classList.add('on', 'show');
        b.classList.toggle('cover-slot', !!(list[0].cover || list[0].t === 'cover'));
        b.setAttribute('aria-label', 'Play selected domino on ' + trainName(key));
        b.textContent = (list[0].cover || list[0].t === 'cover') ? 'cover' : '+';
      } else if (humanTurn && state.pending && state.pending.train === key && state.pending.failed.indexOf(state.turn) === -1) {
        // mandatory cover pending: keep the cover slot visible even before selection
        b.classList.add('on', 'show', 'cover-slot');
        b.textContent = 'cover';
        b.setAttribute('aria-label', 'Cover the double on ' + trainName(key));
      } else {
        b.classList.remove('on', 'show', 'cover-slot');
      }
    });
  }

  /* ---------------- moves ---------------- */
  function applyCommon(mv, byAI) {
    if (!byAI && singleHuman && state.phase === 'play') {
      undoStack.push(JSON.stringify(state));
      if (undoStack.length > 14) undoStack.shift();
    }
    lastMoveTrainKey = mv.t === 'play' || mv.t === 'cover' ? (mv.t === 'cover' ? state.pending.train : mv.train) : null;
    try {
      E.applyMove(state, mv);
    } catch (err) {
      // a failed move must never freeze the board: roll back to the last save
      // (or the pre-move snapshot) and keep the game interactive
      try {
        undoStack.push(JSON.stringify(state));
        if (undoStack.length > 14) undoStack.shift();
        selectedTileId = null;
        render();
        toast('That move hit a glitch — board restored. Try again.', 'warn', 3500);
      } catch (e2) { restoreSave(); }
      return;
    }
    selectedTileId = null;
    saveGame();
    render();
  }

  function onTileTap(ev) {
    if (busy || !state || state.phase !== 'play' || state.players[state.turn].isAI) return;
    var id = parseInt(ev.currentTarget.dataset.tileId, 10);
    var moves = E.legalMoves(state);
    var options = moves.filter(function (m) { return (m.t === 'play' || m.t === 'cover') && m.tileId === id; });
    if (!options.length) {
      Sfx.play('bad');
      el.hintBar.textContent = 'That domino does not fit anywhere right now.';
      el.hintBar.className = 'hint-bar bad-pips';
      return;
    }
    if (settings.fast && options[0].t === 'play' && !options[0].cover) {
      var pick = pickAuto(options);
      applyCommon(pick, false);
      kick();
      return;
    }
    if (selectedTileId === id) {
      // second tap on the same glowing domino: PLAY it (never silently deselect —
      // double-taps on mobile made the selection vanish and the game felt stuck)
      var pick2 = pickAuto(options);
      applyCommon(pick2, false);
      kick();
      return;
    }
    selectedTileId = id;
    renderButtons();
    renderHandSelection();
  }

  function renderHandSelection() {
    el.hand.querySelectorAll('.domino').forEach(function (d) {
      d.classList.toggle('selected', parseInt(d.dataset.tileId, 10) === selectedTileId);
    });
  }

  function pickAuto(options) {
    var score = function (m) {
      var key = m.train;
      if (key === 'M') return 1;
      var owner = parseInt(key, 10);
      if (owner === state.turn) return 0; // own train first
      return 2 + owner; // others
    };
    return options.slice().sort(function (a, b) { return score(a) - score(b); })[0];
  }

  function onEndpoint(ev) {
    try {
    if (busy || !state || state.phase !== 'play' || state.players[state.turn].isAI) return;
    var key = ev.currentTarget.dataset.train;
    var opts = movesForSelected();
    if (!opts.length && state.pending && state.pending.train === key) {
      // allow direct cover tap if the selected tile covers (or pick any cover tile)
      var covers = E.legalMoves(state).filter(function (m) { return m.t === 'cover'; });
      if (covers.length && selectedTileId !== null) {
        var mine = covers.filter(function (m) { return m.tileId === selectedTileId; });
        if (mine.length) { applyCommon(mine[0], false); kick(); return; }
      }
      Sfx.play('bad');
      return;
    }
    var match = opts.filter(function (m) {
      var mk = m.t === 'cover' ? state.pending.train : m.train;
      return mk === key;
    });
    if (!match.length) { Sfx.play('bad'); return; }
    var mv = match[0];
    if (mv.t === 'cover') { applyCommon(mv, false); kick(); return; }
    if (mv.cover) { applyCommon(mv, false); kick(); return; }
    applyCommon(mv, false);
    kick();
    } catch (err) {
      try { render(); } catch (e2) {}
      toast('Something went wrong on that tap — the board was refreshed.', 'warn', 3000);
    }
  }

  /* ---------------- turn flow ---------------- */
  function kick() {
    clearTimeout(aiTimer);
    if (paused) return;
    if (!state) return;
    if (state.phase === 'roundEnd') { showRoundModal(); return; }
    if (state.phase === 'gameEnd') { showEndModal(); return; }
    var pl = state.players[state.turn];
    if (pl.isAI) {
      busy = true;
      renderButtons();
      aiTimer = setTimeout(function () {
        var mv;
        try { mv = E.chooseAIMove(state, pl.diff); }
        catch (e) { mv = E.legalMoves(state)[0]; }
        try { applyCommon(mv, true); }
        catch (e) { toast('Recovered from a glitch — replaying your saved game', 'warn'); restoreSave(); return; }
        busy = false;
        kick();
      }, 720);
    } else {
      busy = false;
      maybeGate();
      renderButtons();
    }
  }

  function maybeGate() {
    if (singleHuman) { lastGateTurn = state.turn; return; }
    if (lastGateTurn === state.turn) return;
    lastGateTurn = state.turn;
    var pl = state.players[state.turn];
    el.passGateTitle.textContent = 'Pass the device';
    el.passGateText.textContent = 'Hand it to ' + pl.name + ' — tap below when ready, ' + pl.name + '.';
    el.passGateReady.textContent = "I'm " + pl.name + ' — show my tiles';
    el.passGate.hidden = false;
    el.passGateReady.focus();
  }

  function restoreSave() {
    var s = lsGet(LS.save, null);
    if (s && s.state) { state = s.state; lastLogPos = state.log.length; render(); kick(); }
    else startNewGame();
  }

  /* ---------------- modals ---------------- */
  function scoreTable(includeRound) {
    var tbl = document.createElement('table');
    tbl.className = 'score-table';
    var thead = document.createElement('tr');
    ['Player', 'Tiles left', 'Pips', 'Round pts', 'Total'].forEach(function (h, idx) {
      var th = document.createElement('th');
      th.textContent = h;
      if (idx >= 1) th.className = 'num';
      thead.appendChild(th);
    });
    var head = document.createElement('thead'); head.appendChild(thead); tbl.appendChild(head);
    var body = document.createElement('tbody');
    var minTotal = Math.min.apply(null, state.players.map(function (p) { return p.score; }));
    state.players.forEach(function (p, i) {
      var tr = document.createElement('tr');
      if (!includeRound && p.score === minTotal) tr.className = 'winner';
      if (i === 0 && singleHuman) tr.classList.add('you-row');
      [p.name, String(p.hand.length), String(E.pips(p.hand)), String(p.roundScore), String(p.score)].forEach(function (v, idx) {
        var td = document.createElement('td');
        td.textContent = v;
        if (idx >= 1) td.className = 'num';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    tbl.appendChild(body);
    return tbl;
  }

  function showRoundModal() {
    var info = state.roundEndInfo;
    el.roundTitle.textContent = 'Round ' + state.round + (info && info.blocked ? ' — all players blocked' : ' complete');
    el.roundTable.innerHTML = '';
    el.roundTable.appendChild(scoreTable(true));
    el.roundNext.textContent = state.round < state.cfg.rounds ? 'Start round ' + (state.round + 1) : 'See final results';
    el.modalRound.hidden = false;
    el.roundNext.focus();
  }

  function showEndModal() {
    var w = state.players[state.gameEndInfo.winner];
    el.endTitle.textContent = '🏆 ' + (singleHuman && state.gameEndInfo.winner === 0 ? 'You win!' : w.name + ' wins!');
    el.endTable.innerHTML = '';
    el.endTable.appendChild(scoreTable(false));
    stats.games++;
    if (state.gameEndInfo.winner === 0) {
      stats.wins++;
      var myScore = state.players[0].score;
      if (stats.best === null || myScore < stats.best) stats.best = myScore;
    }
    lsSet(LS.stats, stats);
    el.endStats.textContent = 'Games played: ' + stats.games + ' · Wins: ' + stats.wins +
      (stats.best !== null ? ' · Your best total: ' + stats.best + ' pts' : '');
    el.modalEnd.hidden = false;
    el.endAgain.focus();
    Sfx.play('win');
    lsDel(LS.save);
  }

  /* ---------------- buttons ---------------- */
  function doDraw() {
    if (busy || state.phase !== 'play' || state.players[state.turn].isAI) return;
    applyCommon({ t: 'draw' }, false);
    kick();
  }
  el.btnDraw.addEventListener('click', doDraw);
  if (el.byBtn) el.byBtn.addEventListener('click', function () {
    if (!el.btnDraw.hidden) doDraw();
  });
  el.btnPass.addEventListener('click', function () {
    if (busy || state.phase !== 'play' || state.players[state.turn].isAI) return;
    var moves = E.legalMoves(state);
    var mv = moves[0];
    if (mv && (mv.t === 'pass' || mv.t === 'failCover')) { applyCommon(mv, false); kick(); }
  });
  el.btnUndo.addEventListener('click', function () {
    if (!undoStack.length || busy || !singleHuman) return;
    clearTimeout(aiTimer); busy = false;
    state = JSON.parse(undoStack.pop());
    selectedTileId = null; lastLogPos = state.log.length; lastMoveTrainKey = null;
    saveGame(); render();
    toast('Move undone');
  });
  el.btnHint.addEventListener('click', function () {
    if (busy || state.phase !== 'play' || state.players[state.turn].isAI) return;
    var mv;
    try { mv = E.chooseAIMove(state, 'hard'); } catch (e) { return; }
    if (!mv) return;
    var msg;
    if (mv.t === 'play' || mv.t === 'cover') {
      var hand = state.players[state.turn].hand;
      for (var i = 0; i < hand.length; i++) {
        if (hand[i].id === mv.tileId) {
          msg = 'Hint: play ' + hand[i].a + '|' + hand[i].b + ' on ' + trainName(mv.t === 'cover' ? state.pending.train : mv.train) + '.';
          el.hand.querySelectorAll('.domino').forEach(function (d) {
            if (parseInt(d.dataset.tileId, 10) === mv.tileId) d.classList.add('hinted');
          });
          break;
        }
      }
      var key = mv.t === 'cover' ? state.pending.train : mv.train;
      document.querySelectorAll('.end-btn').forEach(function (b) {
        if (b.dataset.train === key) b.classList.add('on', 'show');
      });
    } else if (mv.t === 'draw') msg = 'Hint: draw from the boneyard.';
    else msg = 'Hint: pass this turn.';
    el.hintBar.textContent = msg;
    el.hintBar.className = 'hint-bar';
    clearTimeout(lastHintTimer);
    lastHintTimer = setTimeout(function () {
      el.hand.querySelectorAll('.hinted').forEach(function (d) { d.classList.remove('hinted'); });
    }, 2800);
  });
  el.btnSort.addEventListener('click', function () {
    if (busy || state.phase !== 'play' || state.players[state.turn].isAI) return;
    var h = state.players[state.turn].hand;
    h.sort(function (a, b) { return (b.a + b.b) - (a.a + a.b) || b.a - a.a || b.b - b.b; });
    saveGame(); renderHand();
    toast('Sorted heaviest first');
  });
  el.btnNew.addEventListener('click', function () {
    clearTimeout(aiTimer); busy = false;
    openSettings();
  });

  /* ---------------- settings / help / theme / sound ---------------- */
  function syncHumansOptions() {
    var total = parseInt(el.setPlayers.value, 10) + 1;
    var cur = parseInt(el.setHumans.value, 10) || 1;
    el.setHumans.innerHTML = '';
    for (var i = 1; i <= total; i++) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = i === 1 ? 'Just me' : i + ' players (pass-and-play)';
      el.setHumans.appendChild(o);
    }
    el.setHumans.value = String(Math.max(1, Math.min(cur, total)));
  }
  function openSettings() {
    el.setSetmax.value = String(settings.setMax);
    el.setPlayers.value = String(settings.opponents);
    syncHumansOptions();
    el.setHumans.value = String(Math.max(1, Math.min(settings.humans, settings.opponents + 1)));
    el.setDiff.value = settings.diff;
    el.setRounds.value = String(settings.rounds);
    el.setFast.checked = !!settings.fast;
    el.modalSettings.hidden = false;
    el.settingsStart.focus();
  }
  el.setPlayers.addEventListener('change', syncHumansOptions);
  el.settingsForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    settings.setMax = parseInt(el.setSetmax.value, 10);
    settings.opponents = parseInt(el.setPlayers.value, 10);
    settings.humans = parseInt(el.setHumans.value, 10);
    settings.diff = el.setDiff.value;
    settings.rounds = parseInt(el.setRounds.value, 10);
    settings.fast = el.setFast.checked;
    lsSet(LS.settings, settings);
    el.modalSettings.hidden = true;
    el.modalEnd.hidden = true;
    lastGateTurn = -1;
    startNewGame();
  });
  el.settingsCancel.addEventListener('click', function () { el.modalSettings.hidden = true; });
  el.btnHelp.addEventListener('click', function () { el.modalHelp.hidden = false; el.helpClose.focus(); });
  el.helpClose.addEventListener('click', function () { el.modalHelp.hidden = true; });
  el.roundNext.addEventListener('click', function () {
    el.modalRound.hidden = true;
    E.startNextRound(state);
    lastGateTurn = -1;
    el.shell.removeAttribute('data-fit'); // fresh deal: let pieces grow back
    chunkedSig = null;
    saveGame(); render();
    if (state.phase === 'gameEnd') { showEndModal(); return; }
    toast('Round ' + state.round + ' — ' + state.players[state.turn].name + ' plays the ' + state.engine.a + '|' + state.engine.b + ' engine', 'good');
    kick();
  });
  el.endAgain.addEventListener('click', function () {
    el.modalEnd.hidden = true;
    startNewGame();
  });
  el.endSettings.addEventListener('click', function () {
    el.modalEnd.hidden = true;
    openSettings();
  });
  el.passGateReady.addEventListener('click', function () {
    el.passGate.hidden = true;
    renderHand(); renderButtons();
  });

  function applyTheme(t) { document.documentElement.dataset.theme = t; lsSet(LS.theme, t); }
  applyTheme(lsGet(LS.theme, window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  el.btnTheme.addEventListener('click', function () {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  function syncSoundBtn() {
    el.btnSound.setAttribute('aria-pressed', Sfx.enabled ? 'true' : 'false');
    el.btnSound.textContent = Sfx.enabled ? '🔊' : '🔇';
    if (el.pauseSound) el.pauseSound.textContent = Sfx.enabled ? '🔊 Sound: on' : '🔇 Sound: off';
  }
  el.btnSound.addEventListener('click', function () {
    Sfx.enabled = !Sfx.enabled;
    lsSet(LS.sound, Sfx.enabled);
    syncSoundBtn();
    if (Sfx.enabled) Sfx.play('place');
  });
  syncSoundBtn();

  /* ---- dual input: keyboard bindings (desktop) ----
     ←/→ or A/D: browse hand · ↑/↓ or W/S: browse train ends ·
     Enter/Space: select / play (native button activation) ·
     Esc: deselect → pause menu · U undo · H hint · O sort · M mute · F fullscreen */
  var handFocus = -1, endFocus = -1;
  function handTiles() { return Array.prototype.slice.call(document.querySelectorAll('#hand .domino')); }
  function focusHandTile(i) {
    var t = handTiles();
    if (!t.length) return;
    handFocus = ((i % t.length) + t.length) % t.length;
    t[handFocus].focus();
  }
  function visibleEnds() { return Array.prototype.slice.call(document.querySelectorAll('.end-btn.on')); }
  function focusEnd(i) {
    var e = visibleEnds();
    if (!e.length) return;
    endFocus = ((i % e.length) + e.length) % e.length;
    e[endFocus].focus();
  }
  function anyModalOpen() {
    return !el.modalPause.hidden || !el.modalHelp.hidden || !el.modalSettings.hidden ||
           !el.modalRound.hidden || !el.modalEnd.hidden;
  }
  // tap diagnostics (capture phase): records what actually receives clicks
  document.addEventListener('click', function (ev) {
    window.__clickLog = window.__clickLog || [];
    var t = ev.target;
    window.__clickLog.push({
      t: t.tagName + (t.dataset && t.dataset.tileId ? '#' + t.dataset.tileId : ''),
      x: ev.clientX, y: ev.clientY,
      tile: !!(t.closest && t.closest('#hand')),
      playable: !!(t.classList && t.classList.contains('playable'))
    });
    if (window.__clickLog.length > 10) window.__clickLog.shift();
  }, true);

  document.addEventListener('keydown', function (ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var tag = (ev.target && ev.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (ev.key === 'Escape') {
      if (!el.modalPause.hidden) { resumeFromPause(); return; }
      if (!el.modalHelp.hidden) { el.modalHelp.hidden = true; return; }
      if (!el.modalSettings.hidden) { el.modalSettings.hidden = true; return; }
      if (!el.modalRound.hidden || !el.modalEnd.hidden) return; // game-flow modals stay
      if (selectedTileId !== null) { selectedTileId = null; renderButtons(); renderHandSelection(); return; }
      openPause();
      return;
    }
    if (typing || anyModalOpen() || !state || state.phase !== 'play') return;
    switch (ev.key) {
      case 'ArrowLeft': case 'a': case 'A':
        ev.preventDefault(); focusHandTile(handFocus < 0 ? 0 : handFocus - 1); break;
      case 'ArrowRight': case 'd': case 'D':
        ev.preventDefault(); focusHandTile(handFocus < 0 ? 0 : handFocus + 1); break;
      case 'ArrowUp': case 'w': case 'W':
        ev.preventDefault(); focusEnd(endFocus < 0 ? 0 : endFocus - 1); break;
      case 'ArrowDown': case 's': case 'S':
        ev.preventDefault(); focusEnd(endFocus < 0 ? 0 : endFocus + 1); break;
      case 'u': case 'U': el.btnUndo.click(); break;
      case 'h': case 'H': el.btnHint.click(); break;
      case 'o': case 'O': el.btnSort.click(); break;
      case 'm': case 'M': el.btnSound.click(); break;
      case 'f': case 'F': toggleFS(); break;
      case 'p': case 'P': openPause(); break;
      case 'Enter': case ' ':
        // explicit activation: identical behavior everywhere, no reliance on
        // platform Enter->click synthesis (some embedded browsers skip it)
        if (tag === 'button' && !ev.target.disabled) { ev.preventDefault(); ev.target.click(); }
        else if (ev.key === ' ') ev.preventDefault(); // stop page scroll
        break;
    }
  });

  /* ---- pause menu (Esc / ☰) + auto-pause when the tab hides ---- */
  function openPause() {
    if (!state || state.phase !== 'play') return;
    paused = true;
    clearTimeout(aiTimer);
    Sfx.suspend();
    updatePauseStats();
    syncPauseSound();
    el.modalPause.hidden = false;
    el.pauseResume.focus();
  }
  function resumeFromPause() {
    el.modalPause.hidden = true;
    paused = false;
    Sfx.resume();
    if (state && state.phase === 'play') kick();
  }
  function updatePauseStats() {
    var bits = ['Round ' + state.round + ' of ' + state.cfg.rounds];
    bits.push('Games ' + stats.games + ' · Wins ' + stats.wins);
    if (stats.best !== null) bits.push('★ Best ' + stats.best);
    el.pauseStats.textContent = bits.join(' — ');
  }
  function syncPauseSound() {
    el.pauseSound.textContent = Sfx.enabled ? '🔊 Sound: on' : '🔇 Sound: off';
  }
  el.btnPause.addEventListener('click', function () { tap(); openPause(); });
  el.pauseResume.addEventListener('click', function () { tap(); resumeFromPause(); });
  el.pauseNew.addEventListener('click', function () {
    el.modalPause.hidden = true; paused = false; Sfx.resume(); openSettings();
  });
  el.pauseHelp.addEventListener('click', function () { el.modalHelp.hidden = false; el.helpClose.focus(); });
  el.pauseSound.addEventListener('click', function () { el.btnSound.click(); syncPauseSound(); });
  el.pauseTheme.addEventListener('click', function () { el.btnTheme.click(); });

  /* ---- fullscreen (guarded: iOS Safari on iPhone has no Element API) ---- */
  function toggleFS() {
    tap();
    var root = document.documentElement;
    if (!document.fullscreenElement && root.requestFullscreen) {
      var p = root.requestFullscreen();
      if (p && p.catch) p.catch(function () {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }
  document.addEventListener('fullscreenchange', function () {
    var on = !!document.fullscreenElement;
    if (el.btnFS) el.btnFS.textContent = on ? '⤡' : '⛶';
    if (el.pauseFS) el.pauseFS.textContent = on ? '⤡ Exit fullscreen' : '⛶ Fullscreen';
  });
  if (!document.documentElement.requestFullscreen && el.btnFS) el.btnFS.hidden = true;
  el.btnFS.addEventListener('click', toggleFS);
  if (el.pauseFS) el.pauseFS.addEventListener('click', toggleFS);

  /* haptic tick + fresh fold check on every HUD action */
  [el.btnUndo, el.btnHint, el.btnSort, el.btnNew, el.btnSound].forEach(function (b) {
    if (!b) return;
    var orig = b.onclick;
    b.addEventListener('click', function () { tap(); scheduleFit(); });
  });
  [el.modalHelp, el.modalSettings].forEach(function (ov) {
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.hidden = true; });
  });
  el.modalPause.addEventListener('click', function (e) { if (e.target === el.modalPause) resumeFromPause(); });

  /* ---------------- boot ---------------- */
  /* ---- fit-to-fold engine ----
     The whole game must live in the first fold. For each candidate size tier
     (base -> nano) we re-chunk the serpentine rows at that tier's real tile
     size and measure; the first tier where the shell AND the opponents column
     hold everything wins. All layout-sensitive passes are rAF-batched and the
     sweep only runs on resize/rotation/board changes — no permanent loop. */
  var fitQueued = false, chunkedSig = null;
  var FIT_TIERS = ['compact', 'small', 'tiny', 'micro', 'nano'];
  function currentChunkSig() {
    var cs = getComputedStyle(el.shell);
    return (el.shell.getAttribute('data-fit') || 'base') + '|' + (parseInt(cs.getPropertyValue('--train-h'), 10) || 0);
  }
  function fitFold() {
    if (!el.shell || !state) return;
    var side = el.shell.querySelector('.opponent-rows');
    function over() {
      if (el.shell.scrollHeight > el.shell.clientHeight + 1 || el.shell.scrollWidth > el.shell.clientWidth + 1) return true;
      return !!(side && side.scrollHeight > side.clientHeight + 2);
    }
    // Sweep candidates; re-chunk ONLY when a candidate's tile size differs from
    // what the current rows were built at — a stable layout costs zero renders,
    // so taps can never land on replaced elements.
    function setTier(t) { if (t === 'base') el.shell.removeAttribute('data-fit'); else el.shell.setAttribute('data-fit', t); }
    var tiers = ['base'].concat(FIT_TIERS);
    var cur = el.shell.getAttribute('data-fit') || 'base';
    var idx = Math.max(0, tiers.indexOf(cur));
    var chosen = tiers[tiers.length - 1];
    var i = idx;
    for (; i < tiers.length; i++) {
      setTier(tiers[i]);
      if (chunkedSig !== currentChunkSig()) render();
      if (!over()) { chosen = tiers[i]; break; }
    }
    // recovery: after trains shrink, walk back UP to the largest tier that
    // still fits so tiles never stay tiny on big screens
    var ci = tiers.indexOf(chosen);
    while (ci > 0) {
      var up = tiers[ci - 1];
      setTier(up);
      if (chunkedSig !== currentChunkSig()) render();
      if (over()) { setTier(chosen); if (chunkedSig !== currentChunkSig()) render(); break; }
      ci--; chosen = up;
    }
    setTier(chosen);
    if (chunkedSig !== currentChunkSig()) render();
  }
  var fitBurst = 0, fitBurstStart = 0;
  function scheduleFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(function () {
      fitQueued = false;
      var now = performance.now();
      if (now - fitBurstStart > 600) { fitBurst = 0; fitBurstStart = now; }
      if (++fitBurst > 10) return; // safety: stop any tier oscillation
      fitFold();
    });
  }
  var rszTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(rszTimer);
    rszTimer = setTimeout(scheduleFit, 80);
  });
  window.addEventListener('orientationchange', function () { setTimeout(scheduleFit, 120); });
  window.addEventListener('pagehide', saveGame);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { saveGame(); clearTimeout(aiTimer); Sfx.suspend(); }
    else if (!paused) { Sfx.resume(); if (state && state.phase === 'play') kick(); }
  });

  var saved = lsGet(LS.save, null);
  if (saved && saved.state && saved.state.phase && saved.state.phase !== 'gameEnd' && saved.state.cfg) {
    // offer to resume
    state = saved.state;
    singleHuman = state.cfg.humans === 1;
    el.board.dataset.set = String(state.cfg.setMax);
    lastLogPos = state.log.length;
    render();
    kick();
    var overlay = document.createElement('div');
    overlay.className = 'overlay';
    var dlg = document.createElement('div');
    dlg.className = 'dialog';
    dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true');
    var h = document.createElement('h2'); h.textContent = 'Welcome back!';
    var p = document.createElement('p');
    p.textContent = 'Resume your game? Round ' + state.round + ' of ' + state.cfg.rounds + ' — ' +
      state.players.map(function (pl) { return pl.name + ' ' + pl.score; }).join(', ') + ' pts.';
    var row = document.createElement('div'); row.className = 'dialog-actions';
    var yes = document.createElement('button'); yes.className = 'primary-btn'; yes.textContent = 'Resume game';
    var no = document.createElement('button'); no.className = 'ghost-btn'; no.textContent = 'Start a new game';
    function doResume() {
      overlay.remove();
      toast('Game resumed — good luck!', 'good');
    }
    yes.addEventListener('click', doResume);
    // never a dead end: ANY tap on this overlay that is not one of its two
    // buttons resumes the game (covers backdrop, title and text clicks)
    overlay.addEventListener('click', function (e) {
      if (!(e.target.closest && e.target.closest('button'))) doResume();
    });
    no.addEventListener('click', function () {
      overlay.remove();
      openSettings();
    });
    row.appendChild(yes); row.appendChild(no);
    dlg.appendChild(h); dlg.appendChild(p); dlg.appendChild(row);
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);
    yes.focus();
    // keep board interactive-but-paused until choice: block AI by pausing timers? kick already ran.
  } else {
    state = null;
    startNewGame();
  }

  scheduleFit();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
