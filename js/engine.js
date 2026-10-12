/*
 * Mexican Train Dominoes — game engine (pure logic, no DOM).
 * Works in browser (window.MTEngine) and Node (module.exports) for self-testing.
 *
 * Rules implemented (matching the classic game as described on mexicantrain.com):
 *  - Double-6/9/12/15 sets. Engine = highest double held at deal; its holder places it
 *    in the hub and takes the first turn. If nobody holds a double, players draw in
 *    turn until one is found (pigeonhole guarantees one exists when the boneyard is empty).
 *  - Every train (personal + Mexican) starts from the hub; first tile must match engine value.
 *  - Unstarted personal trains are closed to everyone. Open trains are marked and playable by all.
 *  - Draw 1 from the boneyard only when you have no legal play; play if able after drawing,
 *    otherwise your train is marked open and the turn passes.
 *  - Doubles must be covered: the player who plays a double immediately plays a second
 *    matching tile on it (bonus play). If they can't, their train opens and the next player
 *    must cover it; players who fail also open their train. Once every player has failed,
 *    covering the double becomes an optional normal play for anyone. While a double is
 *    pending, its train cannot be extended past the double.
 *  - Round ends when a player empties their hand (scores 0) or all players are blocked
 *    (lowest pip hand scores 0). Everyone else scores the pips left in their hand.
 *    Lowest cumulative score after the configured number of rounds wins.
 */
(function (global) {
  'use strict';

  /* ---------- seeded RNG (mulberry32) ---------- */
  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function assert(cond, msg) {
    if (!cond) { throw new Error('MT-ASSERT: ' + msg); }
  }

  var HAND_SIZE = { 6: 7, 9: 10, 12: 13, 15: 15 };
  var AI_NAMES = ['Dilly', 'Trainyard Tess', 'Rusty Spike'];

  function makeSet(max) {
    var tiles = [], id = 0;
    for (var a = 0; a <= max; a++) {
      for (var b = a; b <= max; b++) tiles.push({ id: id++, a: a, b: b });
    }
    return tiles;
  }

  function shuffled(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function clone(state) { return JSON.parse(JSON.stringify(state)); }
  function pips(hand) { var s = 0; for (var i = 0; i < hand.length; i++) s += hand[i].a + hand[i].b; return s; }
  function findTile(hand, id) { for (var i = 0; i < hand.length; i++) if (hand[i].id === id) return i; return -1; }

  function log(state, type, data) {
    state.log.push(Object.assign({ type: type, turn: state.turn, round: state.round }, data || {}));
    if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
  }

  /* ---------- setup ---------- */
  function defaultHandSize(setMax, playerCount) {
    var setTiles = ((setMax + 1) * (setMax + 2)) / 2;
    return Math.max(4, Math.min(HAND_SIZE[setMax] || 13, Math.floor(setTiles / playerCount)));
  }

  function deal(state, rng) {
    var setMax = state.cfg.setMax;
    var n = state.cfg.playerCount;
    var tiles = shuffled(makeSet(setMax), rng);
    var per = defaultHandSize(setMax, n);
    for (var i = 0; i < n; i++) {
      state.players[i].hand = tiles.slice(i * per, (i + 1) * per);
      state.players[i].started = false;
      state.players[i].open = false;
      state.players[i].roundScore = 0;
    }
    state.boneyard = tiles.slice(n * per);
    state.trains = { M: [] };
    for (i = 0; i < n; i++) state.trains[i] = [];

    // Engine: highest double actually held. Draw-in-turn fallback (never needed when
    // all tiles are dealt: only setMax+1 non-doubles exist, hands hold more than that).
    var holder = -1, best = -1;
    for (i = 0; i < n; i++) {
      for (var j = 0; j < state.players[i].hand.length; j++) {
        var t = state.players[i].hand[j];
        if (t.a === t.b && t.a > best) { best = t.a; holder = i; }
      }
    }
    if (holder === -1) {
      // Scan order starts at the round's starting player; first double drawn becomes engine.
      // All doubles are in the boneyard here (hands hold none), so a double always turns up.
      for (var k = 0; holder === -1 && state.boneyard.length > 0; k++) {
        var p = (state.starter + k) % n;
        var drawn = state.boneyard.pop();
        state.players[p].hand.push(drawn);
        if (drawn.a === drawn.b) { holder = p; best = drawn.a; }
      }
      assert(holder !== -1, 'no double found for engine');
    }
    var engineTile = null;
    var idx = findTile(state.players[holder].hand, (function find(){ for (var q=0;q<state.players[holder].hand.length;q++){var tt=state.players[holder].hand[q]; if(tt.a===tt.b&&tt.a===best) return tt.id;} return -1;})());
    assert(idx !== -1, 'engine tile missing from holder hand');
    engineTile = state.players[holder].hand.splice(idx, 1)[0];
    state.engine = { a: engineTile.a, b: engineTile.b, tileId: engineTile.id };
    state.turn = holder;
    state.pending = null;
    state.consecutivePasses = 0;
    state.drewThisTurn = false;
    log(state, 'engine', { player: holder, val: best });
  }

  function newGame(cfg) {
    var setMax = cfg.setMax || 12;
    assert([6, 9, 12, 15].indexOf(setMax) !== -1, 'bad setMax');
    var n = cfg.playerCount || 4;
    assert(n >= 2 && n <= 4, 'bad playerCount');
    var players = [];
    for (var i = 0; i < n; i++) {
      players.push({
        name: (cfg.names && cfg.names[i]) || (i === 0 ? 'You' : (AI_NAMES[i - 1] || 'Player ' + (i + 1))),
        isAI: cfg.humans ? i >= cfg.humans : i > 0,
        diff: (cfg.diffs && cfg.diffs[i]) || 'hard',
        hand: [], started: false, open: false, score: 0, roundScore: 0
      });
    }
    var state = {
      v: 1,
      cfg: { setMax: setMax, rounds: cfg.rounds || 3, playerCount: n, humans: cfg.humans || 1 },
      rngState: (cfg.seed >>> 0) || ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0),
      round: 1, starter: 0, turn: 0,
      players: players, boneyard: [], engine: null, trains: {},
      pending: null, consecutivePasses: 0,
      phase: 'play', roundEndInfo: null, gameEndInfo: null, drewThisTurn: false,
      log: []
    };
    var rng = makeRng(state.rngState);
    state.rngState = (rng() * 4294967296) >>> 0;
    deal(state, makeRng(state.rngState));
    state.rngState = (rng() * 4294967296) >>> 0;
    return state;
  }

  /* ---------- board queries ---------- */
  // Open pip value at the growing end of a train.
  function openEnd(state, key) {
    var tr = state.trains[key];
    if (!tr || tr.length === 0) return state.engine ? state.engine.a : null;
    var last = tr[tr.length - 1];
    if (state.pending && state.pending.train === key && state.pending.tileId === last.tileId) {
      return null; // unsatisfied double blocks this end (only its side branch is playable)
    }
    return last.flipped ? last.a : last.b;
  }

  function mayWriteTrain(state, key, playerIdx) {
    if (key === 'M') return true;
    var owner = parseInt(key, 10);
    if (owner === playerIdx) return true;
    return state.players[owner].open;
  }

  function isTrainPlayable(state, key, playerIdx) {
    if (!mayWriteTrain(state, key, playerIdx)) return false;
    // An unstarted personal train may only be started by its owner (first tile must
    // match the engine value — openEnd handles that); nobody else can play on it.
    if (key !== 'M' && !state.players[parseInt(key, 10)].started && parseInt(key, 10) !== playerIdx) return false;
    if (state.pending && state.pending.train === key) return false; // must cover, not extend
    return true;
  }

  // Legal plays of `tile` from playerIdx's hand: [{train, flipped, cover?}]
  function playsForTile(state, tile, playerIdx) {
    var out = [];
    // A released pending double (everyone failed to cover) stays as a normal cover play
    // for anyone; that train still cannot be extended past the unsatisfied double.
    if (state.pending && state.pending.released && (tile.a === state.pending.val || tile.b === state.pending.val)) {
      out.push({ train: state.pending.train, flipped: false, cover: true });
    }
    var keys = Object.keys(state.trains);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (!isTrainPlayable(state, key, playerIdx)) continue;
      var end = openEnd(state, key);
      if (end === null) continue;
      if (tile.a === end) out.push({ train: key, flipped: false });
      else if (tile.b === end && tile.a !== tile.b) out.push({ train: key, flipped: true });
    }
    return out;
  }

  function coverPlays(state, playerIdx) {
    var out = [], hand = state.players[playerIdx].hand;
    for (var i = 0; i < hand.length; i++) {
      if (hand[i].a === state.pending.val || hand[i].b === state.pending.val) out.push({ t: 'cover', tileId: hand[i].id });
    }
    return out;
  }

  function hasCoverInHand(state, playerIdx, excludeId) {
    var hand = state.players[playerIdx].hand;
    for (var i = 0; i < hand.length; i++) {
      if (hand[i].id === excludeId) continue;
      if (hand[i].a === state.pending.val || hand[i].b === state.pending.val) return true;
    }
    return false;
  }

  // All legal moves for the current player. Always non-empty.
  function legalMoves(state) {
    var p = state.turn, pl = state.players[p], moves = [];
    if (state.phase !== 'play') return moves;
    var i, j;
    if (state.pending && state.pending.failed.indexOf(p) === -1) {
      var covers = coverPlays(state, p);
      for (i = 0; i < covers.length; i++) moves.push(covers[i]);
      if (moves.length === 0) {
        // No cover tile in hand: draw once from the boneyard to try to cover,
        // otherwise the obligation passes on (train opens).
        moves.push(state.boneyard.length > 0 && !state.drewThisTurn ? { t: 'draw' } : { t: 'failCover' });
      }
      return moves;
    }
    var hand = pl.hand;
    for (i = 0; i < hand.length; i++) {
      var opts = playsForTile(state, hand[i], p);
      for (j = 0; j < opts.length; j++) {
        moves.push({ t: 'play', tileId: hand[i].id, train: opts[j].train, flipped: opts[j].flipped, cover: opts[j].cover });
      }
    }
    if (moves.length > 0) return moves;
    if (state.boneyard.length > 0 && !state.drewThisTurn) return [{ t: 'draw' }];
    return [{ t: 'pass' }];
  }

  /* ---------- mutations ---------- */
  function nextTurn(state) {
    state.turn = (state.turn + 1) % state.cfg.playerCount;
    state.drewThisTurn = false;
  }

  function endRound(state, outIdx) {
    var n = state.cfg.playerCount, scores = [], i, minP = Infinity;
    for (i = 0; i < n; i++) {
      var ps = pips(state.players[i].hand);
      scores.push(ps);
      if (ps < minP) minP = ps;
    }
    if (outIdx !== null && outIdx !== undefined) {
      scores[outIdx] = 0;
      log(state, 'out', { player: outIdx });
    } else {
      for (i = 0; i < n; i++) if (scores[i] === minP) scores[i] = 0; // blocked round: lowest hand goes free
      log(state, 'blocked', {});
    }
    for (i = 0; i < n; i++) {
      state.players[i].roundScore = scores[i];
      state.players[i].score += scores[i];
    }
    state.phase = 'roundEnd';
    state.roundEndInfo = { out: (outIdx === undefined ? null : outIdx), scores: scores, blocked: outIdx === null || outIdx === undefined };
    log(state, 'roundEnd', { scores: scores.slice() });
  }

  function checkBlocked(state) {
    if (state.consecutivePasses >= state.cfg.playerCount) {
      endRound(state, null);
      return true;
    }
    return false;
  }

  function releasePendingIfNeeded(state) {
    if (!state.pending || state.pending.released) return;
    if (state.pending.failed.length >= state.cfg.playerCount) {
      // Everyone failed to cover once: the obligation lifts, the blocked-round counter
      // resets, and covering the double becomes an optional normal play for anyone.
      state.pending.released = true;
      state.consecutivePasses = 0;
      log(state, 'pendingReleased', { val: state.pending.val });
    }
  }

  function placeTile(state, key, tile, flipped, extra) {
    var isDouble = tile.a === tile.b;
    var plc = { tileId: tile.id, a: tile.a, b: tile.b, flipped: !!flipped, double: isDouble };
    if (extra) for (var k in extra) plc[k] = extra[k];
    state.trains[key].push(plc);
    return plc;
  }

  // Shared cover execution: attach the cover tile to the pending double, clear the
  // obligation, and handle round end (covering player out; also a player left
  // empty-handed behind an unsatisfied double is out once it gets covered).
  function execCover(state, tileId) {
    var p = state.turn, pl = state.players[p], i;
    var ci = findTile(pl.hand, tileId);
    assert(ci !== -1, 'cover: tile not in hand');
    var ct = pl.hand[ci];
    assert(state.pending, 'cover: no pending double');
    assert(ct.a === state.pending.val || ct.b === state.pending.val, 'cover: tile does not match double');
    pl.hand.splice(ci, 1);
    var pend = state.pending;
    for (i = 0; i < state.trains[pend.train].length; i++) {
      if (state.trains[pend.train][i].tileId === pend.tileId) {
        state.trains[pend.train][i].coverTileId = ct.id;
        state.trains[pend.train][i].coverTile = { a: ct.a, b: ct.b };
        break;
      }
    }
    state.consecutivePasses = 0;
    log(state, 'cover', { player: p, val: pend.val, tile: { a: ct.a, b: ct.b } });
    state.pending = null;
    if (pl.hand.length === 0) { endRound(state, p); return state; }
    for (i = 0; i < state.cfg.playerCount; i++) {
      if (state.players[i].hand.length === 0) { endRound(state, i); return state; }
    }
    nextTurn(state);
    checkBlocked(state);
    return state;
  }

  function applyMove(state, move) {
    assert(state.phase === 'play', 'applyMove in phase ' + state.phase);
    var p = state.turn, pl = state.players[p], i;
    state.consecutivePasses = Math.max(0, state.consecutivePasses);

    if (move.t === 'play') {
      if (move.cover) {
        // Covering a released double as a normal play.
        assert(state.pending && state.pending.released, 'cover play: no released pending double');
        return execCover(state, move.tileId);
      }
      var hi = findTile(pl.hand, move.tileId);
      assert(hi !== -1, 'play: tile not in hand');
      var tile = pl.hand[hi];
      var legal = playsForTile(state, tile, p);
      var ok = false;
      for (i = 0; i < legal.length; i++) {
        if (legal[i].train === move.train && legal[i].flipped === !!move.flipped && !!legal[i].cover === !!move.cover) { ok = true; break; }
      }
      assert(ok, 'play: illegal move ' + tile.a + '|' + tile.b + ' on ' + move.train);

      pl.hand.splice(hi, 1);
      var isDouble = tile.a === tile.b;
      placeTile(state, move.train, tile, move.flipped);
      if (move.train !== 'M' && !state.players[parseInt(move.train, 10)].started) {
        state.players[parseInt(move.train, 10)].started = true;
      }
      state.consecutivePasses = 0;
      log(state, 'play', { player: p, tile: { a: tile.a, b: tile.b }, train: move.train, double: isDouble });

      if (isDouble) {
        state.pending = { train: move.train, tileId: tile.id, val: tile.a, failed: [], released: false };
        log(state, 'double', { player: p, val: tile.a, train: move.train });
        if (hasCoverInHand(state, p, tile.id)) {
          return state; // same player must now cover (legalMoves returns cover plays)
        }
        // Cannot cover: own train opens, obligation moves on.
        if (pl.started && !pl.open) { pl.open = true; log(state, 'open', { player: p }); }
        state.pending.failed.push(p);
        state.consecutivePasses++;
        nextTurn(state);
        releasePendingIfNeeded(state);
        checkBlocked(state);
        return state;
      }

      if (pl.hand.length === 0) { endRound(state, p); return state; }
      nextTurn(state);
      checkBlocked(state);
      return state;
    }

    if (move.t === 'cover') {
      assert(state.pending && !state.pending.released, 'cover: no pending double');
      return execCover(state, move.tileId);
    }

    if (move.t === 'failCover') {
      assert(state.pending && state.pending.failed.indexOf(p) === -1, 'failCover: not applicable');
      if (pl.started && !pl.open) { pl.open = true; log(state, 'open', { player: p }); }
      state.pending.failed.push(p);
      state.consecutivePasses++;
      nextTurn(state);
      releasePendingIfNeeded(state);
      checkBlocked(state);
      return state;
    }

    if (move.t === 'draw') {
      assert(state.boneyard.length > 0, 'draw: boneyard empty');
      assert(!state.drewThisTurn, 'draw: already drew this turn');
      assert(!state.pending || coverPlays(state, p).length === 0,
        'draw: cover obligation pending');
      var d = state.boneyard.pop();
      pl.hand.push(d);
      state.drewThisTurn = true;
      log(state, 'draw', { player: p });
      return state; // same player continues: now play if able, else pass / fail cover
    }

    if (move.t === 'pass') {
      assert(legalMoves(state).length === 1 && legalMoves(state)[0].t === 'pass', 'pass: legal plays exist');
      if (pl.started && !pl.open) { pl.open = true; log(state, 'open', { player: p }); }
      state.consecutivePasses++;
      log(state, 'pass', { player: p });
      nextTurn(state);
      checkBlocked(state);
      return state;
    }

    throw new Error('MT-ASSERT: unknown move ' + move.t);
  }

  function startNextRound(state) {
    assert(state.phase === 'roundEnd', 'startNextRound in phase ' + state.phase);
    if (state.round >= state.cfg.rounds) {
      var n = state.cfg.playerCount, best = Infinity, winner = 0;
      for (var i = 0; i < n; i++) {
        var sc = state.players[i].score;
        // tie-break: on equal totals, the player who shed more of their hand ranks higher
        if (sc < best || (sc === best && state.players[i].hand.length < state.players[winner].hand.length)) {
          best = sc; winner = i;
        }
      }
      state.phase = 'gameEnd';
      state.gameEndInfo = { winner: winner, scores: state.players.map(function (pl) { return pl.score; }) };
      log(state, 'gameEnd', { winner: winner });
      return state;
    }
    state.round++;
    state.starter = (state.starter + 1) % state.cfg.playerCount;
    state.roundEndInfo = null;
    state.phase = 'play';
    state.pending = null;
    state.consecutivePasses = 0;
    state.drewThisTurn = false;
    var rng = makeRng(state.rngState);
    state.rngState = (rng() * 4294967296) >>> 0;
    deal(state, makeRng(state.rngState));
    state.rngState = (rng() * 4294967296) >>> 0;
    return state;
  }

  /* ---------- AI ---------- */
  function movePips(state, move) {
    if (move.t !== 'play' && move.t !== 'cover') return 0;
    var hand = state.players[state.turn].hand;
    var i = findTile(hand, move.tileId);
    return i === -1 ? 0 : hand[i].a + hand[i].b;
  }

  function isDoubleTile(state, move) {
    if (move.t !== 'play') return false;
    var hand = state.players[state.turn].hand;
    var i = findTile(hand, move.tileId);
    return i !== -1 && hand[i].a === hand[i].b;
  }

  function canCoverAfter(state, move) {
    if (move.t !== 'play') return false;
    var hand = state.players[state.turn].hand, i = findTile(hand, move.tileId);
    if (i === -1) return false;
    var t = hand[i];
    if (t.a !== t.b) return false;
    for (var j = 0; j < hand.length; j++) {
      if (j === i) continue;
      if (hand[j].a === t.a || hand[j].b === t.a) return true;
    }
    return false;
  }

  function chooseAIMove(state, difficulty) {
    var moves = legalMoves(state);
    if (moves.length === 0) throw new Error('MT-ASSERT: AI has no moves');
    if (moves.length === 1) return moves[0];
    var p = state.turn, pl = state.players[p], i, m;
    var rnd = makeRng((state.rngState ^ (p * 2654435761) ^ (state.round * 97)) >>> 0);

    if (difficulty === 'easy') {
      // Mostly random, but take free plays (covers) and avoid failing covers when able.
      return moves[Math.floor(rnd() * moves.length)];
    }

    var handPips = pips(pl.hand);
    var scored = [];
    for (i = 0; i < moves.length; i++) {
      m = moves[i];
      if (m.t === 'draw') { scored.push({ m: m, s: 0.5 + rnd() }); continue; }
      if (m.t === 'pass' || m.t === 'failCover') { scored.push({ m: m, s: -50 + rnd() }); continue; }
      var s = 0;
      var pp = movePips(state, m);
      var dbl = isDoubleTile(state, m);
      var coverOK = canCoverAfter(state, m);
      if (m.t === 'cover') s = 40 + pp; // covering is mandatory and safe
      else {
        s = pp * (pl.hand.length <= 3 ? 3 : 1.2); // dump heavy tiles, urgently late-game
        if (dbl) s += coverOK ? 5 : -8;
        if (m.train === 'M') s += 2;
        else if (parseInt(m.train, 10) === p) s += pl.started ? 3.5 : 4.5;
        else s += 1; // opponent open train
        if (difficulty === 'hard') {
          // Flexibility: favour tiles whose outward end matches several remaining tiles.
          var outward = m.flipped ? tileOf(state, m.tileId).a : tileOf(state, m.tileId).b;
          var match = 0;
          for (var j = 0; j < pl.hand.length; j++) {
            var h = pl.hand[j];
            if (h.id === m.tileId) continue;
            if (h.a === outward || h.b === outward) match++;
          }
          s += match * 1.1;
          // Keep opponents' open trains as a dumping ground only when own options are heavy.
          if (m.train !== 'M' && parseInt(m.train, 10) !== p && handPips < 20) s -= 2;
        }
      }
      s += rnd() * (difficulty === 'medium' ? 3 : 1);
      scored.push({ m: m, s: s });
    }
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored[0].m;
  }

  function tileOf(state, id) {
    var hand = state.players[state.turn].hand;
    var i = findTile(hand, id);
    if (i !== -1) return hand[i];
    // search board (rare: AI sim only needs hand tiles)
    var keys = Object.keys(state.trains);
    for (var k = 0; k < keys.length; k++) {
      var tr = state.trains[keys[k]];
      for (var j = 0; j < tr.length; j++) {
        if (tr[j].tileId === id) return { id: id, a: tr[j].a, b: tr[j].b };
        if (tr[j].coverTileId === id && tr[j].coverTile) return { id: id, a: tr[j].coverTile.a, b: tr[j].coverTile.b };
      }
    }
    return { id: id, a: 0, b: 0 };
  }

  /* ---------- invariant checker (used by self-tests) ---------- */
  function checkInvariants(state) {
    var n = state.cfg.playerCount, i, j, k;
    assert(state.engine, 'no engine');
    var seen = {};
    // train adjacency: consecutive tiles share pips; first matches engine
    var keys = Object.keys(state.trains);
    var boardCount = 0;
    for (k = 0; k < keys.length; k++) {
      var key = keys[k], tr = state.trains[key];
      var prevOut = state.engine.a;
      for (i = 0; i < tr.length; i++) {
        var pl = tr[i];
        var inVal = pl.flipped ? pl.b : pl.a;
        assert(inVal === prevOut, 'train ' + key + ' adjacency broken at ' + i);
        if (pl.double && pl.coverTile) {
          assert(pl.coverTile.a === pl.a || pl.coverTile.b === pl.a, 'cover mismatch');
        }
        assert(!seen[pl.tileId], 'tile ' + pl.tileId + ' on board twice');
        seen[pl.tileId] = 1;
        boardCount++;
        if (pl.coverTileId !== undefined && pl.coverTileId !== null) {
          assert(!seen[pl.coverTileId], 'cover tile on board twice');
          seen[pl.coverTileId] = 1;
          boardCount++;
        }
        prevOut = pl.flipped ? pl.a : pl.b;
      }
    }
    if (state.engine.tileId !== undefined && state.engine.tileId !== null) { seen[state.engine.tileId] = 1; boardCount++; }
    // hands disjoint from board and boneyard
    var total = boardCount;
    for (i = 0; i < n; i++) {
      total += state.players[i].hand.length;
      for (j = 0; j < state.players[i].hand.length; j++) {
        assert(!seen[state.players[i].hand[j].id], 'tile in hand and on board');
        seen[state.players[i].hand[j].id] = 1;
      }
    }
    total += state.boneyard.length;
    for (j = 0; j < state.boneyard.length; j++) assert(!seen[state.boneyard[j].id], 'tile in boneyard twice');
    var setTiles = ((state.cfg.setMax + 1) * (state.cfg.setMax + 2)) / 2;
    assert(total === setTiles, 'tile count wrong: ' + total + ' != ' + setTiles);
    // pending sanity
    if (state.pending) {
      var found = false;
      var tr = state.trains[state.pending.train];
      for (i = 0; i < tr.length; i++) if (tr[i].tileId === state.pending.tileId) found = true;
      assert(found, 'pending double not on its train');
    }
    // turn within range; moves always exist during play
    assert(state.turn >= 0 && state.turn < n, 'turn out of range');
    if (state.phase === 'play') assert(legalMoves(state).length > 0, 'no legal moves during play');
    return true;
  }

  var API = {
    newGame: newGame,
    applyMove: applyMove,
    legalMoves: legalMoves,
    chooseAIMove: chooseAIMove,
    startNextRound: startNextRound,
    openEnd: openEnd,
    pips: pips,
    clone: clone,
    checkInvariants: checkInvariants,
    defaultHandSize: defaultHandSize,
    makeRng: makeRng
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (global) global.MTEngine = API;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
