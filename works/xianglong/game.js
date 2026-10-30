/*
 * 降龙 · 前端
 *
 * 三种运行方式共用一个「对局」对象：
 *   - solo ：房主就在本页（this.host），电脑也在本地
 *   - host ：房主在本页，客人通过 PeerJS 连进来
 *   - guest：本页是客人，状态都从房主推过来
 *
 * 房主负责结算，客人只负责显示和预演。所有状态最终都走 host.js。
 */
(function () {
  'use strict';

  var E = window.Xianglong;
  var Host = window.XianglongHost;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ======================= 小工具 ======================= */

  var NAME_KEY = 'xl.name';
  var MUTE_KEY = 'xl.mute';

  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch (e) { /* 隐私模式里没有 localStorage，忽略 */ }
    return null;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function cleanName(raw, fallback) {
    var s = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 8);
    return s || fallback;
  }

  function online() {
    return typeof window.Peer === 'function';
  }

  /* 单机、房主的 id 都是 p0/p1…；在线时客人是 guest，避免两边撞名 */
  var MY = 'p0';

  /* ======================= 音效 ======================= */

  var Sound = {
    ctx: null,
    muted: store(MUTE_KEY) === '1',
    init: function () {
      if (this.ctx) return this.ctx;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { this.ctx = new AC(); } catch (e) { this.ctx = null; }
      return this.ctx;
    },
    tone: function (freq, dur, type, gain) {
      if (this.muted) return;
      var ctx = this.init();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume();
      var t = ctx.currentTime;
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain || 0.06, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    },
    pick: function () { this.tone(660, 0.06, 'triangle', 0.04); },
    commit: function () { this.tone(440, 0.08, 'triangle', 0.05); this.tone(880, 0.1, 'triangle', 0.04); },
    block: function () { this.tone(300, 0.12, 'sawtooth', 0.03); },
    hit: function () { this.tone(150, 0.22, 'square', 0.05); this.tone(90, 0.3, 'sine', 0.07); },
    win: function () { [523, 659, 784].forEach(function (f, i) { setTimeout(function () { Sound.tone(f, 0.18, 'triangle', 0.06); }, i * 110); }); }
  };

  /* ======================= 对局状态 ======================= */

  var G = {
    mode: 'solo',          // solo | host | guest
    host: null,            // Host 实例（房主/单机）
    peer: null,            // PeerJS Peer
    conn: null,            // PeerJS DataConnection（客人 / 房主的那条）
    players: [],           // 最近一次公开状态
    me: MY,
    round: 0,
    phase: 'idle',
    pick: null,            // 选中的招式 id
    aim: null,             // 选中的目标 id
    locked: false,         // 本回合已提交
    deadlineAt: 0,
    roundMs: 15000,
    tick: null,
    spectator: false,
    diedRound: 0,
    joining: false,
    submitted: []
  };

  var orderRequest = 0;
  var lastRoundSeen = 0;

  function findMe() {
    for (var i = 0; i < G.players.length; i++) if (G.players[i].id === G.me) return G.players[i];
    return null;
  }

  function nameOf(id) {
    for (var i = 0; i < G.players.length; i++) if (G.players[i].id === id) return G.players[i].name;
    return id;
  }

  function levelName(lv) {
    var L = E.LEVELS[lv] || E.LEVELS[1];
    return L.name;
  }

  /* ======================= 屏幕切换 ======================= */

  var SCREENS = ['screen-lobby', 'screen-game', 'screen-result'];

  function show(id) {
    SCREENS.forEach(function (s) { $('#' + s).hidden = s !== id; });
    window.scrollTo(0, 0);
  }

  /* ======================= 大厅 ======================= */

  function readSettings() {
    var cpu = 3, level = 1;
    var onCount = $('#solo-count .seg-btn.is-on');
    var onLevel = $('#solo-level .seg-btn.is-on');
    if (onCount) cpu = +onCount.getAttribute('data-cpu');
    if (onLevel) level = +onLevel.getAttribute('data-level');
    return { cpu: cpu, level: level };
  }

  function bindSeg(root, onChange) {
    root.addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn');
      if (!btn || !root.contains(btn)) return;
      $$('.seg-btn', root).forEach(function (b) {
        var on = b === btn;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      Sound.pick();
      if (onChange) onChange(btn);
    });
  }

  var LEVEL_DESC = {
    0: '不读场面，手里有什么就扔什么，偶尔想起来防一下。',
    1: '看对手最高能量选防御档位，会省气，专挑软柿子。',
    2: '每回合把所有招式推演一遍，盯着能活下来、能带走人的那手；攒气时最难缠。'
  };

  function setNetStatus(text, isError) {
    var el = $('#net-status');
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  function initLobby() {
    var remembered = store(NAME_KEY) || '';
    $('#solo-name').value = remembered;
    $('#net-name').value = remembered;

    bindSeg($('#solo-count'));
    bindSeg($('#solo-level'), function (btn) {
      $('#solo-level-desc').textContent = LEVEL_DESC[btn.getAttribute('data-level')] || '';
    });

    $('#form-solo').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = cleanName($('#solo-name').value, '我');
      store(NAME_KEY, name);
      var cfg = readSettings();
      startSolo(name, cfg.cpu, cfg.level);
    });

    $('#btn-host').addEventListener('click', function () {
      var name = cleanName($('#net-name').value, '房主');
      store(NAME_KEY, name);
      createRoom(name);
    });

    $('#form-join').addEventListener('submit', function (e) {
      e.preventDefault();
      var code = ($('#join-code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 6) { setNetStatus('房间码是 6 位字母数字。', true); return; }
      var name = cleanName($('#net-name').value, '客人');
      store(NAME_KEY, name);
      joinRoom(code, name);
    });

    $('#join-code').addEventListener('input', function () {
      this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });

    if (!online()) {
      $('#btn-host').disabled = true;
      $('#form-join .btn').disabled = true;
      setNetStatus('联机脚本没有加载出来（可能是广告拦截或网络问题）。单机不受影响。', true);
    }
  }

  /* ======================= 单机 ======================= */

  var CPU_NAMES = ['铁头', '阿七', '老陈', '小满', '石头', '白露', '阿青', '大龙', '二丫', '包子'];
  var soloCfg = null;  // 再来一局沿用它，而不是回头读大厅里可能已经被改动的控件

  function startSolo(myName, cpuCount, level) {
    endNet();
    G.mode = 'solo';
    G.me = MY;
    G.spectator = false;
    soloCfg = { name: myName, cpu: cpuCount, level: level };
    G.host = new Host({
      deliver: function (pid, msg) { onHostMessage(pid, msg); },
      onEnd: function () { /* 结算屏在 reveal 里处理 */ }
    });
    G.host.setPlayers([{ id: MY, name: myName, isCpu: false }]);

    var pool = CPU_NAMES.slice();
    for (var i = 0; i < cpuCount; i++) {
      var pickIdx = Math.floor(Math.random() * pool.length);
      var nm = pool.splice(pickIdx, 1)[0] || ('电脑' + (i + 1));
      G.host.addPlayer({ id: 'p' + (i + 1), name: nm, isCpu: true, level: level });
    }

    $('#hud-mode').textContent = '单机 · ' + (cpuCount + 1) + ' 人 · ' + levelName(level);
    enterGame();
    G.host.start();
  }

  /* ======================= 帧同步的计时器 ======================= */

  function setDeadline(deadlineAt, roundMs) {
    G.deadlineAt = deadlineAt || 0;
    G.roundMs = roundMs || 15000;
    tickTimer();
  }

  function tickTimer() {
    var box = $('#hud-timer-box');
    var bar = $('#ring-bar');
    var sec = $('#hud-seconds');
    if (G.phase !== 'choosing' && G.phase !== 'locking') {
      box.classList.remove('is-low', 'is-locking');
      box.classList.toggle('is-locking', G.phase === 'locking');
      sec.textContent = G.phase === 'locking' ? '…' : '—';
      if (G.phase !== 'choosing') bar.style.strokeDashoffset = '0';
      return;
    }
    var left = Math.max(0, G.deadlineAt - Date.now());
    var ratio = Math.max(0, Math.min(1, left / G.roundMs));
    box.classList.toggle('is-locking', G.phase === 'locking');
    box.classList.toggle('is-low', left <= 5000);
    sec.textContent = Math.ceil(left / 1000);
    bar.style.strokeDashoffset = String((1 - ratio) * 97.4);
  }

  function startTicker() {
    if (G.tick) return;
    G.tick = setInterval(tickTimer, 200);
  }

  function stopTicker() {
    clearInterval(G.tick);
    G.tick = null;
  }

  /* ======================= 进入对战 ======================= */

  function enterGame() {
    show('screen-game');
    $('#log').innerHTML = '';
    G.pick = null;
    G.aim = null;
    G.locked = false;
    G.spectator = false;
    G.diedRound = 0;
    setHint('');
    startTicker();
    renderControls();
  }

  /* 房主把消息送到每个玩家：单机就自己收，在线就转发给连接 */
  function onHostMessage(pid, msg) {
    if (G.mode === 'solo') {
      if (pid === MY) onMessage(msg);
      return;
    }
    if (pid === MY) {
      onMessage(msg);
      return;
    }
    if (pid === 'guest' && G.conn && G.conn.open) {
      G.conn.send(msg);
    }
  }

  /* 客人发来的消息（在线客人） / 本地提交（单机、房主） */
  function onMessage(msg) {
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'state') {
      G.players = msg.players || G.players;
      G.me = msg.you || G.me;
      G.round = msg.round;
      G.phase = msg.phase;
      G.submitted = msg.submitted || [];
      setDeadline(Date.now() + (msg.deadlineIn || 0), msg.roundMs);
      // 房主重开一局时，客人停在结算页也要被拉回牌桌
      if (G.mode === 'guest' && !$('#screen-result').hidden) {
        enterGame();
        hideResult();
      }
      if (msg.round !== lastRoundSeen) {
        lastRoundSeen = msg.round;
        G.locked = false;
        G.pick = null;
        G.aim = null;
        $('#log').innerHTML = '';
      } else if (msg.yourOrder) {
        G.locked = true;
        G.pick = msg.yourOrder.action;
        G.aim = msg.yourOrder.target;
      }
      var me = findMe();
      G.spectator = !!(me && !me.alive);
      renderGame();
      return;
    }

    if (msg.t === 'reveal') {
      G.phase = msg.over ? 'over' : 'reveal';
      // 用结过算的表盘，谁这回合被打掉，座位和观战提示才会立刻更新
      var wasAlive = !!(findMe() && findMe().alive);
      G.players = msg.results || G.players;
      var nowAlive = !!(findMe() && findMe().alive);
      // 出局发生在哪一回合，结算屏要用
      if (wasAlive && !nowAlive) G.diedRound = msg.round || G.round;
      G.spectator = !nowAlive;
      renderGame();
      renderReveal(msg);
      if (msg.over) {
        setTimeout(function () { showResult(msg); }, 1400);
      }
      return;
    }

    if (msg.t === 'kick') {
      endNet();
      show('screen-lobby');
      setNetStatus(msg.text || '房主离开了。', true);
    }
  }

  /* ======================= 玩家操作 ======================= */

  function canAct() {
    var me = findMe();
    return !!(me && me.alive && G.phase === 'choosing' && !G.locked && !G.spectator);
  }

  function chooseSkill(id) {
    if (!canAct()) return;
    var me = findMe();
    var s = E.SKILLS[id];
    if (!s || !E.canChoose(me, id, G.players.filter(function (p) { return p.alive; }).length)) return;
    if (s.kind === 'defend' && E.willFoul(me, id)) return;
    G.pick = id;
    if (s.kind !== 'attack') G.aim = null;
    else if (!G.aim || !aliveTarget(G.aim)) G.aim = null;
    Sound.pick();
    renderGame();
  }

  function aliveTarget(id) {
    return G.players.some(function (p) { return p.id === id && p.alive; });
  }

  function aimAt(id) {
    if (!canAct() || !G.pick) return;
    if (E.SKILLS[G.pick].kind !== 'attack' || id === G.me || !aliveTarget(id)) return;
    G.aim = id;
    Sound.pick();
    renderGame();
  }

  function commit() {
    if (!canAct()) return;
    var s = G.pick ? E.SKILLS[G.pick] : null;
    if (!s) { setHint('先选一招。', true); return; }
    if (s.kind === 'attack' && !G.aim) { setHint('出掌要选一个目标。', true); return; }
    G.locked = true;
    Sound.commit();
    sendOrder({ action: G.pick, target: G.aim });
    renderGame();
  }

  function sendOrder(order) {
    if (G.mode === 'solo') {
      G.host.submit(MY, order);
      return;
    }
    if (G.mode === 'host') {
      G.host.submit(MY, order);
      return;
    }
    // 客人
    if (G.conn && G.conn.open) G.conn.send({ t: 'action', action: order.action, target: order.target });
  }

  /* ======================= 渲染：牌桌 ======================= */

  function seatMark(p) {
    return esc(p.name.slice(0, 1));
  }

  function seatTag(p) {
    if (p.id === G.me) return '你';
    if (p.isCpu) return levelName(p.level);
    return '在线';
  }

  function streakText(p) {
    var out = [];
    if (p.defMidStreak) out.push('中' + p.defMidStreak);
    if (p.defBigStreak) out.push('大' + p.defBigStreak);
    return out.join(' ');
  }

  function renderBoard(orders, results) {
    var board = $('#board');
    var canAim = canAct() && G.pick && E.SKILLS[G.pick].kind === 'attack';
    var html = G.players.map(function (p) {
      var cls = ['seat'];
      if (p.id === G.me) cls.push('is-me');
      if (!p.alive) cls.push('is-dead');
      if (canAim && p.alive && p.id !== G.me) cls.push('is-target');
      if (G.aim === p.id) cls.push('is-aimed');
      if (results && results[p.id] && results[p.id].died) cls.push('is-hit');
      var orderHtml = '';
      if (orders && orders[p.id] && orders[p.id].action !== 'none') {
        var res = orders[p.id];
        var sk = E.SKILLS[res.action];
        // 这回合死掉的人，他亮出来的招式也能看到（结算后才显示）
        orderHtml = '<span class="seat-order ' +
          (res.foul ? 'is-foul ' : '') +
          (sk && sk.kind === 'attack' ? 'is-attack' : sk && sk.kind === 'defend' ? 'is-defend' : '') +
          '">' + esc(sk ? sk.name : res.action) + (res.target ? '→' + esc(nameOf(res.target)) : '') + '</span>';
      }
      var stateText;
      if (!p.alive) stateText = '出局';
      else if (G.phase === 'reveal' || G.phase === 'over') stateText = '';
      else if (G.locked && p.id === G.me) stateText = '已出招';
      else if (G.submitted.indexOf(p.id) >= 0) stateText = '已交牌';
      else if (p.isCpu) stateText = '在想…';
      else stateText = '';
      return '<li class="' + cls.join(' ') + '" data-pid="' + esc(p.id) + '"' + (canAim && p.alive && p.id !== G.me ? ' tabindex="0" role="button"' : '') + '>' +
        orderHtml +
        '<span class="seat-mark" aria-hidden="true">' + seatMark(p) + '</span>' +
        '<span class="seat-name"><span>' + esc(p.name) + '</span><span class="seat-tag">' + esc(seatTag(p)) + '</span></span>' +
        '<span class="seat-meta"><span class="seat-energy">⚡ ' + (p.energy | 0) + '</span><span class="seat-streak">' + streakText(p) + '</span><span class="seat-state">' + esc(stateText) + '</span></span>' +
        '</li>';
    }).join('');
    board.innerHTML = html;
  }

  function renderGame() {
    var me = findMe();
    $('#hud-round').textContent = G.round || 1;
    if (me) {
      $('#hud-name').textContent = me.name;
      $('#hud-energy').textContent = me.alive ? me.energy : '—';
    }
    tickTimer();
    renderBoard(null, null);
    renderControls();
    $('#spectate-note').hidden = !G.spectator;
  }

  /* ======================= 渲染：操作区 ======================= */

  function setHint(text, alert) {
    var h = $('#hint');
    h.textContent = text || '';
    h.classList.toggle('is-alert', !!alert);
  }

  function renderControls() {
    var me = findMe();
    var act = canAct();
    var s = G.pick ? E.SKILLS[G.pick] : null;
    var aliveCount = G.players.filter(function (p) { return p.alive; }).length;

    $$('#controls .skill').forEach(function (btn) {
      var id = btn.getAttribute('data-skill');
      var sk = E.SKILLS[id];
      var ok = !!me && act && E.canChoose(me, id, aliveCount) && !(sk.kind === 'defend' && E.willFoul(me, id));
      btn.disabled = !ok;
      btn.classList.toggle('is-on', G.pick === id);
      btn.setAttribute('aria-pressed', G.pick === id ? 'true' : 'false');
    });

    var commitBtn = $('#btn-commit');
    if (!me || !me.alive || G.spectator) {
      commitBtn.disabled = true;
      commitBtn.textContent = '观战中';
    } else if (G.locked) {
      commitBtn.disabled = true;
      commitBtn.textContent = me && !me.alive ? '你已出局' : '已出招，等其他人…';
    } else if (G.phase !== 'choosing') {
      commitBtn.disabled = true;
      commitBtn.textContent = '结算中…';
    } else if (!s) {
      commitBtn.disabled = true;
      commitBtn.textContent = '先选一招，再点目标';
    } else if (s.kind === 'attack' && !G.aim) {
      commitBtn.disabled = true;
      commitBtn.textContent = '点一个对手';
    } else {
      commitBtn.disabled = false;
      commitBtn.textContent = s.kind === 'attack' ? '出 ' + s.name + ' → ' + nameOf(G.aim) : '出 ' + s.name;
    }

    if (!act) {
      if (G.spectator) setHint('你已出局，看这一局打完。');
      else if (G.locked && G.phase === 'choosing') setHint('已出招，等其他人交牌。');
      else if (G.phase === 'locking') setHint('收招…');
      else setHint('');
    } else if (!s) {
      setHint('选一招。出掌要先点招式，再点目标。');
    } else if (s.kind === 'attack' && !G.aim) {
      setHint('再点一个对手当目标。', true);
    } else if (s.kind === 'attack') {
      setHint(s.name + ' 打 ' + nameOf(G.aim) + '。');
    } else {
      setHint('');
    }

    if (me && G.phase === 'choosing' && me.defMidStreak >= 5) {
      setHint('中防已经连用 5 次，这回合再用会犯规。', true);
    } else if (me && G.phase === 'choosing' && me.defBigStreak >= 4) {
      setHint('大防已经连用 4 次，这回合再用会犯规。', true);
    }
  }

  /* ======================= 渲染：结算 / 战报 ======================= */

  function skillLabel(id) {
    var s = E.SKILLS[id];
    return s ? s.name : id;
  }

  function evText(e) {
    var n = nameOf;
    var strong = function (id) { return '<b>' + esc(n(id)) + '</b>'; };
    switch (e.t) {
      case 'gain':
        return strong(e.p) + ' 降龙，回 1 气（' + e.energy + '）';
      case 'block':
        return strong(e.a) + ' 出 ' + esc(e.skill) + '（' + e.power + '），' + strong(e.d) + ' ' + esc(e.def) + '挡住';
      case 'break':
        return strong(e.a) + ' 出 ' + esc(e.skill) + '（' + e.power + '），破了 ' + strong(e.d) + ' 的 ' + esc(e.def);
      case 'open_hit':
        return strong(e.a) + ' 出 ' + esc(e.skill) + '（' + e.power + '），' + strong(e.d) + '在攒气，没防住';
      case 'backstab':
        return strong(e.a) + ' 趁 ' + strong(e.d) + '出掌时背刺（' + e.power + '）';
      case 'foul_hit':
        return strong(e.a) + ' 出 ' + esc(e.skill) + '（' + e.power + '），' + strong(e.d) + ' ' + esc(foulName(e.foul)) + '作废';
      case 'foul':
        return strong(e.p) + ' 的 ' + esc(skillLabel(e.skill)) + ' ' + esc(e.text) + '，变成降龙';
      case 'clash':
        return '对波：' + strong(e.winner) + '（' + e.winPower + '）压过 ' + strong(e.loser) + '（' + e.losePower + '）';
      case 'clash_draw':
        return '对波：' + strong(e.a) + ' 与 ' + strong(e.d) + ' 都是 ' + e.power + '，两掌相抵';
      case 'clash_skip':
        return '';
      case 'dead':
        return strong(e.p) + ' 出局';
      default:
        return '';
    }
  }

  function foulName(f) {
    if (!f) return '';
    var s = E.SKILLS[f.skill];
    return (s ? s.name : '') + (f.why === 'energy' ? '因气不够' : f.why === 'limit' ? '因连用超限' : '因目标无效');
  }

  function renderReveal(msg) {
    var results = {};
    (msg.results || []).forEach(function (r) { results[r.id] = r; });
    renderBoard(results, results);

    var logs = msg.events || msg.logs || [];
    var ul = $('#log');
    var any = false;
    logs.forEach(function (e) {
      var text = evText(e);
      if (!text) return;
      any = true;
      var li = document.createElement('li');
      if (e.t === 'dead') li.className = 'is-dead';
      li.innerHTML = text;
      ul.appendChild(li);
    });
    if (!any) {
      var li2 = document.createElement('li');
      li2.className = 'is-quiet';
      li2.textContent = '这回合没有涉及到你的事。';
      ul.appendChild(li2);
    }

    var deaths = (msg.results || []).filter(function (r) { return r.died; }).length;
    if (deaths) Sound.hit(); else Sound.block();
    renderControls();
  }

  /* ======================= 结算屏 ======================= */

  function showResult(msg) {
    var me = null;
    (msg.players || []).forEach(function (p) { if (p.id === G.me) me = p; });
    var survivors = (msg.players || []).filter(function (p) { return p.alive; });
    var kicker = $('#result-kicker');
    var title = $('#result-title');
    var sub = $('#result-sub');

    if (msg.winner) {
      var w = msg.winner;
      if (w === G.me) {
        kicker.textContent = '你活到了最后';
        title.textContent = '赢了';
        sub.textContent = '第 ' + G.round + ' 回合结束，场上只剩你一个人。';
        Sound.win();
      } else {
        kicker.textContent = '本局结束';
        title.textContent = nameOf(w) + ' 赢';
        sub.textContent = me && !me.alive ? '你在第 ' + (G.diedRound || G.round) + ' 回合出局。' : '';
      }
    } else if (msg.draw) {
      kicker.textContent = '本局结束';
      title.textContent = '同归于尽';
      sub.textContent = '最后一回合全灭，算平局。';
    } else {
      // 剩两个人以上：房主判定结束但场上没分出胜负（理论上不该发生）
      kicker.textContent = '本局结束';
      title.textContent = survivors.map(function (p) { return p.name; }).join('、');
      sub.textContent = '';
    }

    var again = $('#btn-again');
    var isHost = G.mode === 'solo' || G.mode === 'host';
    again.hidden = !isHost;
    if (!isHost) {
      // 客人的局由房主开，这里只提示一句
      sub.textContent = (sub.textContent ? sub.textContent + ' ' : '') + '等房主再开一局。';
    }

    stopTicker();
    show('screen-result');
  }

  /* ======================= 在线：PeerJS ======================= */

  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function newCode() {
    var out = '';
    var buf = new Uint8Array(6);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(buf);
    else for (var i = 0; i < 6; i++) buf[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < 6; j++) out += CODE_CHARS[buf[j] % CODE_CHARS.length];
    return out;
  }

  function peerId(code) { return 'xl2-' + code; }

  function endNet() {
    if (G.conn) { try { G.conn.close(); } catch (e) {} G.conn = null; }
    if (G.peer) { try { G.peer.destroy(); } catch (e) {} G.peer = null; }
    G.joining = false;
  }

  /*
   * 对局中途断线：谁都别再操作，退回大厅并说明原因。
   * 先断开自己这一头的 peer：客人那边也是靠它把连接收掉的，
   * 不然退回大厅后还挂着一条半死的连接。
   * 但 close 事件里不能直接 destroy 自己（事件正从它身上发出来），
   * 所以放到下一拍。
   */
  function dropToLobby(text) {
    stopNetWatch();
    if (G.host) { try { G.host.stop(); } catch (e) {} }
    G.host = null;
    G.mode = 'solo';
    G.me = MY;
    G.phase = 'idle';
    G.players = [];
    G.submitted = [];
    lastRoundSeen = 0;
    stopTicker();
    var conn = G.conn, peer = G.peer;
    G.conn = null;
    G.peer = null;
    setTimeout(function () {
      if (conn) { try { conn.close(); } catch (e) {} }
      if (peer) { try { peer.destroy(); } catch (e) {} }
    }, 0);
    show('screen-lobby');
    setNetStatus(text || '连接断开了。', true);
  }

  /*
   * close 事件不带「主动走 / 掉线」的信息，随便给个说法就行；
   * 客人主动离开会先发一条 bye，那条在 data 里处理。
   */
  function closeText(who) {
    return '和' + who + '的连接断了，这一局结束。';
  }

  /*
   * PeerJS 只管信令那条 WebSocket；对方把页面关掉的时候，数据连接既不会
   * close 也不报错，只会停在 disconnected。所以双人局里自己盯着 WebRTC 的
   * 连接状态和心跳：对方不再回话，就当掉线。
   */
  var PING_MS = 3000;
  var PING_GIVEUP_MS = 12000;

  var Net = { watch: null, ping: null, lastHeard: 0 };

  function stopNetWatch() {
    if (Net.watch) { clearInterval(Net.watch); Net.watch = null; }
    if (Net.ping) { clearInterval(Net.ping); Net.ping = null; }
  }

  function watchPeer(conn) {
    stopNetWatch();
    Net.lastHeard = Date.now();
    // 已经发现掉线的连接不再重复处理
    var dead = false;
    var lost = function (why) {
      if (dead) return;
      dead = true;
      dropToLobby(why);
    };

    var pc = conn.peerConnection || null;
    var onState = function () {
      if (dead) return;
      var st = pc.connectionState;
      if (st === 'failed' || st === 'closed') lost('和对方的连接断了，这一局结束。');
      // 页面关掉时这里会先变 disconnected；再等心跳判死
    };
    if (pc) {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { onState(); return; }
      pc.addEventListener('connectionstatechange', onState);
    }

    Net.ping = setInterval(function () {
      if (dead || !conn.open) return;
      if (Net.lastHeard && Date.now() - Net.lastHeard > PING_GIVEUP_MS) {
        lost('和对方的连接断了，这一局结束。');
        return;
      }
      try { conn.send({ t: 'ping' }); } catch (e) { /* 下个心跳再判 */ }
    }, PING_MS);
  }

  /*
   * 收到任何消息都算对方还活着。ping 回一声 pong，别的一概不答，
   * 不然两边会没完没了地互回。
   */
  function heard(data, conn) {
    Net.lastHeard = Date.now();
    if (data.t === 'ping') {
      try { conn.send({ t: 'pong' }); } catch (e) {}
      return true;
    }
    if (data.t === 'pong') return true;
    return false;
  }

  function mediaOk() {
    return window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  function createRoom(name) {
    if (!online()) { setNetStatus('联机脚本没有加载出来。', true); return; }
    if (!mediaOk()) {
      setNetStatus('浏览器只在 https 页面里允许点对点连接。请换 https 打开本站。', true);
      return;
    }
    endNet();
    var code = newCode();
    var modal = $('#modal-room');
    $('#room-code').textContent = code;
    $('#room-peer').textContent = '房间号 ' + code + ' · 信令 ' + peerId(code);
    $('#room-status').textContent = '正在连接信令服务器…';
    $('#room-status').classList.remove('is-error');
    $('#btn-copy-code').textContent = '复制房间码';
    modal.hidden = false;
    $('#btn-copy-code').focus();

    var peer;
    try {
      peer = new window.Peer(peerId(code), { debug: 0 });
    } catch (e) {
      $('#room-status').textContent = '创建信令连接失败：' + e.message;
      return;
    }
    G.peer = peer;
    peer.on('open', function () {
      $('#room-status').textContent = '等对方输入房间码进来…';
    });
    peer.on('error', function (err) {
      var type = err && err.type;
      if (type === 'unavailable-id') {
        // 房间码撞了，换一个再来
        modal.hidden = true;
        if (G.peer === peer) G.peer = null;
        try { peer.destroy(); } catch (e) {}
        createRoom(name);
        return;
      }
      var msg = type === 'peer-unavailable' ? '连不上对方，检查房间码。'
        : type === 'network' || type === 'server-error' ? '信令服务器没连上，稍后再试或换网络。'
        : type === 'browser-incompatible' ? '这个浏览器不支持 WebRTC。'
        : '连接出错：' + (err && err.message ? err.message : type);
      $('#room-status').textContent = msg;
      $('#room-status').classList.add('is-error');
    });
    peer.on('connection', function (conn) {
      if (G.conn && G.conn.open) { try { conn.close(); } catch (e) {} return; }
      acceptGuest(conn, name);
    });
  }

  function acceptGuest(conn, hostName) {
    G.conn = conn;
    var hostReady = false;
    conn.on('open', function () {
      $('#room-status').textContent = '对方已连上。';
      // 等对方的 hello 里带上名字再开局
    });
    conn.on('data', function (data) {
      if (!data || typeof data.t !== 'string') return;
      var beat = heard(data, conn);
      if (data.t === 'hello') {
        if (hostReady) return;
        hostReady = true;
        var gname = cleanName(data.name, '客人');
        var opponent = cleanName(hostName, '房主');
        $('#modal-room').hidden = true;
        startNetHost(opponent, gname, conn);
        watchPeer(conn);
      } else if (data.t === 'action') {
        if (G.host) G.host.submit('guest', { action: data.action, target: data.target });
      } else if (data.t === 'restart' && G.host) {
        G.host.start();
      } else if (data.t === 'bye') {
        // 客人点了离开：这是他主动走的，不是掉线
        if (G.mode === 'host') dropToLobby('对方离开了，这一局结束。');
        else if (G.peer) { $('#modal-room').hidden = true; setNetStatus('对方取消了，重新建房试试。', true); }
      } else if (beat) {
        return;
      }
    });
    conn.on('close', function (data) {
      if (G.conn !== conn) return;
      G.conn = null;
      // 还在房间里等对方进来时，退回大厅就行；已经开打了才算掉线
      if (G.mode !== 'host') {
        $('#modal-room').hidden = true;
        setNetStatus('对方还没进来就断开了，重新建房试试。', true);
        return;
      }
      dropToLobby(closeText(data, '对方'));
    });
    conn.on('error', function () {});
  }

  function startNetHost(hostName, guestName, conn) {
    G.mode = 'host';
    G.me = MY;
    G.conn = conn;
    var h = new Host({
      deliver: function (pid, msg) {
        if (pid === MY) onMessage(msg);
        else if (conn.open) conn.send(msg);
      }
    });
    h.setPlayers([{ id: MY, name: hostName }, { id: 'guest', name: guestName }]);
    G.host = h;
    $('#hud-mode').textContent = '在线 · 2 人';
    enterGame();
    h.start();
  }

  function joinRoom(code, name) {
    if (!online()) { setNetStatus('联机脚本没有加载出来。', true); return; }
    if (!mediaOk()) {
      setNetStatus('浏览器只在 https 页面里允许点对点连接。请换 https 打开本站。', true);
      return;
    }
    endNet();
    G.joining = true;
    setNetStatus('正在连接房间 ' + code + '…');
    var peer;
    try {
      peer = new window.Peer(undefined, { debug: 0 });
    } catch (e) {
      G.joining = false;
      setNetStatus('创建信令连接失败：' + e.message, true);
      return;
    }
    G.peer = peer;
    var settled = false;

    peer.on('open', function () {
      var conn = peer.connect(peerId(code), { reliable: true, metadata: { name: name } });
      G.conn = conn;
      conn.on('open', function () {
        settled = true;
        setNetStatus('连上了，等房主开局…');
        conn.send({ t: 'hello', name: name });
        watchPeer(conn);
      });
      conn.on('data', function (data) {
        if (!data || typeof data.t !== 'string') return;
        if (heard(data, conn)) return;
        if (data.t === 'state' && G.mode !== 'guest') {
          G.mode = 'guest';
          $('#hud-mode').textContent = '在线 · 2 人';
          enterGame();
        }
        if (data.t === 'kick') {
          endNet();
          show('screen-lobby');
          setNetStatus(data.text || '房主离开了。', true);
          return;
        }
        onMessage(data);
      });
      conn.on('close', function (data) {
        if (G.mode !== 'guest') return;
        G.conn = null;
        dropToLobby(closeText(data, '房主'));
      });
    });
    peer.on('error', function (err) {
      var type = err && err.type;
      if (type === 'peer-unavailable') {
        G.joining = false;
        endNet();
        setNetStatus('没找到这个房间。确认房间码，或者让对方重新开房。', true);
      } else if (type === 'network' || type === 'server-error') {
        G.joining = false;
        endNet();
        setNetStatus('信令服务器没连上，稍后再试或换网络。', true);
      } else if (!settled) {
        setNetStatus('连接出错：' + (err && err.message ? err.message : type), true);
      }
    });

    setTimeout(function () {
      if (!settled && G.joining) {
        G.joining = false;
        endNet();
        setNetStatus('连接超时。换网络再试，或者确认你们用的是同一个房间码。', true);
      }
    }, 20000);
  }

  /* ======================= 事件绑定 ======================= */

  function bindGame() {
    $('#controls').addEventListener('click', function (e) {
      var btn = e.target.closest('.skill');
      if (btn) { chooseSkill(btn.getAttribute('data-skill')); return; }
      if (e.target.closest('#btn-commit')) commit();
    });

    $('#board').addEventListener('click', function (e) {
      var seat = e.target.closest('.seat');
      if (seat) aimAt(seat.getAttribute('data-pid'));
    });

    $('#board').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var seat = e.target.closest('.seat');
      if (seat) { e.preventDefault(); aimAt(seat.getAttribute('data-pid')); }
    });

    $('#btn-mute').addEventListener('click', function () {
      Sound.muted = !Sound.muted;
      store(MUTE_KEY, Sound.muted ? '1' : '0');
      this.setAttribute('aria-pressed', Sound.muted ? 'true' : 'false');
      this.textContent = Sound.muted ? '🔇' : '🔊';
      if (!Sound.muted) Sound.pick();
    });
    $('#btn-mute').textContent = Sound.muted ? '🔇' : '🔊';
    $('#btn-mute').setAttribute('aria-pressed', Sound.muted ? 'true' : 'false');

    $('#btn-leave').addEventListener('click', leave);

    $('#btn-again').addEventListener('click', function () {
      if (G.mode === 'solo') {
        var cfg = soloCfg || { name: cleanName(store(NAME_KEY), '我'), cpu: 3, level: 1 };
        startSolo(cfg.name, cfg.cpu, cfg.level);
      } else if (G.mode === 'host' && G.host) {
        show('screen-game');
        startTicker();
        G.players = [];
        hideResult();
        G.host.start();
      } else {
        leave();
      }
    });

    $('#btn-copy-code').addEventListener('click', function () {
      var code = $('#room-code').textContent;
      var btn = this;
      var done = function () { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制房间码'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done, function () { fallbackCopy(code, done); });
      } else {
        fallbackCopy(code, done);
      }
    });

    $('#btn-cancel-room').addEventListener('click', function () {
      $('#modal-room').hidden = true;
      endNet();
    });

    document.addEventListener('visibilitychange', function () {
      // 回到页面时把回合已用掉的时间补算回来
      if (!document.hidden && G.phase === 'choosing') tickTimer();
    });

    window.addEventListener('beforeunload', function (e) {
      if (G.mode === 'solo' || !G.host) return;
      if (G.phase === 'over') return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  function hideResult() {
    $('#log').innerHTML = '';
    lastRoundSeen = 0;
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
  }

  function leave() {
    stopNetWatch();
    if (G.mode === 'guest' && G.conn && G.conn.open) {
      try { G.conn.send({ t: 'bye' }); } catch (e) {}
    }
    if (G.host) {
      try { G.host.stop(); } catch (e) {}
    }
    G.host = null;
    endNet();
    G.mode = 'solo';
    G.me = MY;
    G.phase = 'idle';
    G.players = [];
    G.submitted = [];
    lastRoundSeen = 0;
    $('#modal-room').hidden = true;
    stopTicker();
    show('screen-lobby');
    setNetStatus('');
  }

  /* ======================= 启动 ======================= */

  function boot() {
    initLobby();
    bindGame();

    // 调试/自动化测试用：从地址栏直接开单机
    var q = new URLSearchParams(location.search);
    if (q.has('solo')) {
      var n = Math.max(1, Math.min(5, +(q.get('cpu') || 3)));
      var lv = Math.max(0, Math.min(2, +(q.get('level') || 1)));
      startSolo(cleanName(q.get('name') || store(NAME_KEY), '我'), n, lv);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 给自动化测试留一个只读的把手 */
  window.__xl = {
    state: function () {
      return { mode: G.mode, me: G.me, phase: G.phase, round: G.round, locked: G.locked, spectators: G.spectator, players: G.players };
    },
    pick: chooseSkill,
    aim: aimAt,
    commit: commit
  };
})();
