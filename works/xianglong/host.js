/*
 * 降龙 Xianglong —— 房主逻辑
 *
 * 单机模式和在线对战的房主共用这一个。它只做三件事：
 *   1. 收齐各方出招（缺的按规矩补成降龙）；
 *   2. 到点并发结算，AI 也在这一刻才做决定；
 *   3. 把「公开状态」发给每个人、把「上帝视角战报」只发给当事人。
 *
 * 它不碰 DOM，也不认识 PeerJS：消息通过 deliver(pid, msg) 送出去。
 */
(function (global) {
  'use strict';

  var E = global.Xianglong;
  var ROUND_MS = 15000;
  var RESOLVE_GRACE_MS = 700;
  var REVEAL_MS = 4200;

  function clone(p) {
    return {
      id: p.id, name: p.name, isCpu: p.isCpu, level: p.level,
      energy: p.energy, alive: p.alive,
      defMidStreak: p.defMidStreak, defBigStreak: p.defBigStreak
    };
  }

  function Host(opts) {
    opts = opts || {};
    this.roundMs = opts.roundMs || ROUND_MS;
    this.revealMs = opts.revealMs || REVEAL_MS;
    this.deliver = opts.deliver || function () {};
    this.onEnd = opts.onEnd || function () {};
    this.players = [];
    this.round = 0;
    this.phase = 'idle';
    this.orders = {};
    this.ready = {};
    this.timer = null;
    this.graceTimer = null;
    this.revealTimer = null;
    this.deadlineAt = 0;
    this.started = false;
  }

  Host.prototype.setPlayers = function (list) {
    this.players = list.map(function (p) {
      return {
        id: p.id, name: p.name, isCpu: !!p.isCpu, level: p.level == null ? 1 : p.level,
        energy: 0, alive: true, defMidStreak: 0, defBigStreak: 0
      };
    });
    this.byId = {};
    var self = this;
    this.players.forEach(function (p) { self.byId[p.id] = p; });
  };

  Host.prototype.addPlayer = function (p) {
    this.players.push({
      id: p.id, name: p.name, isCpu: !!p.isCpu, level: p.level == null ? 1 : p.level,
      energy: 0, alive: true, defMidStreak: 0, defBigStreak: 0
    });
    this.byId[p.id] = this.players[this.players.length - 1];
  };

  Host.prototype.removePlayer = function (id) {
    this.players = this.players.filter(function (p) { return p.id !== id; });
    delete this.byId[id];
    delete this.orders[id];
  };

  Host.prototype.humans = function () {
    return this.players.filter(function (p) { return !p.isCpu && p.alive; });
  };

  Host.prototype.snapshot = function (forId) {
    var now = Date.now();
    return {
      t: 'state',
      round: this.round,
      phase: this.phase,
      deadlineIn: Math.max(0, this.deadlineAt - now),
      roundMs: this.roundMs,
      players: this.players.map(clone),
      submitted: Object.keys(this.orders),
      you: forId || null,
      yourOrder: (forId && this.orders[forId]) || null
    };
  };

  Host.prototype.broadcast = function () {
    var self = this;
    this.players.forEach(function (p) {
      self.deliver(p.id, self.snapshot(p.id));
    });
  };

  Host.prototype.start = function () {
    if (!this.players.length) return;
    // 重开一局：所有人回到满血、零气，连用计数清零
    this.players.forEach(function (p) {
      p.energy = 0;
      p.alive = true;
      p.defMidStreak = 0;
      p.defBigStreak = 0;
    });
    this.orders = {};
    this.ready = {};
    this.started = true;
    this.round = 0;
    clearTimeout(this.timer);
    clearTimeout(this.graceTimer);
    clearTimeout(this.revealTimer);
    this.graceTimer = null;
    this.nextRound();
  };

  Host.prototype.nextRound = function () {
    if (!this.started) return;
    this.round += 1;
    this.phase = 'choosing';
    this.orders = {};
    this.ready = {};
    this.deadlineAt = Date.now() + this.roundMs;
    this.broadcast();
    var self = this;
    clearTimeout(this.timer);
    this.timer = setTimeout(function () { self.resolveNow(false); }, this.roundMs);
  };

  Host.prototype.submit = function (pid, order) {
    if (this.phase !== 'choosing') return;
    var p = this.byId[pid];
    if (!p || !p.alive || p.isCpu) return;
    if (!order || !E.SKILLS[order.action]) return;
    var action = order.action;
    var target = typeof order.target === 'string' ? order.target : null;
    if (E.SKILLS[action].kind === 'attack') {
      var tgt = this.byId[target];
      // 目标必须在场；不在场就当没选，交给结算去判犯规也行，
      // 但这里直接拒绝，免得玩家白白被罚。
      if (!tgt || !tgt.alive || tgt.id === pid) return;
    } else {
      target = null;
    }
    this.orders[pid] = { action: action, target: target };
    var self = this;
    var allIn = this.humans().every(function (h) {
      return Object.prototype.hasOwnProperty.call(self.orders, h.id);
    });
    // 人齐了先进入「收招」，等网络上的最后一个动作落地再结算
    if (allIn) this.scheduleResolve();
    else this.broadcast();
  };

  Host.prototype.scheduleResolve = function () {
    if (this.phase !== 'choosing' || this.graceTimer) return;
    this.phase = 'locking';
    this.broadcast();
    var self = this;
    this.graceTimer = setTimeout(function () { self.resolveNow(true); }, RESOLVE_GRACE_MS);
  };

  Host.prototype.resolveNow = function (early) {
    if (this.phase !== 'choosing' && this.phase !== 'locking') return;
    clearTimeout(this.timer);
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.phase = 'resolving';

    var self = this;
    var snap = this.players.map(function (p) {
      var o = self.orders[p.id];
      if (!o) o = { action: 'charge', target: null, auto: true };
      return {
        id: p.id, name: p.name, isCpu: p.isCpu, level: p.level,
        energy: p.energy, alive: p.alive,
        defMidStreak: p.defMidStreak, defBigStreak: p.defBigStreak,
        action: o.action, target: o.target || null
      };
    });

    // AI 在结算这一瞬间才决定，看到的是所有人本回合开始时的状态
    snap.forEach(function (p) {
      if (!p.alive || !p.isCpu) return;
      var o = E.aiDecide(p, snap);
      p.action = o.action;
      p.target = o.target;
    });

    var forced = {};
    snap.forEach(function (p) {
      if (p.alive && !p.isCpu && !self.orders[p.id]) forced[p.id] = 'charge';
    });

    var result = E.resolve(snap, { forced: forced });

    this.players = result.players.map(function (p) {
      var prev = self.byId[p.id];
      return {
        id: p.id, name: p.name, isCpu: p.isCpu, level: p.level,
        energy: p.energy, alive: p.alive,
        defMidStreak: p.defMidStreak, defBigStreak: p.defBigStreak
      };
    });
    this.byId = {};
    this.players.forEach(function (p) { self.byId[p.id] = p; });

    var over = this.players.filter(function (p) { return p.alive; }).length <= 1;
    this.phase = over ? 'over' : 'reveal';

    var self2 = this;
    this.players.forEach(function (p) {
      self2.deliver(p.id, {
        t: 'reveal',
        round: self2.round,
        players: self2.players.map(clone),
        results: result.players,
        events: result.events,
        winner: result.winner,
        draw: result.draw,
        over: over,
        revealMs: self2.revealMs
      });
    });

    if (over) {
      var survivors = this.players.filter(function (p) { return p.alive; });
      this.onEnd({
        winner: survivors.length === 1 ? survivors[0].id : null,
        draw: survivors.length === 0,
        players: this.players.map(clone)
      });
      return;
    }

    clearTimeout(this.revealTimer);
    this.revealTimer = setTimeout(function () {
      if (self2.phase === 'reveal') self2.nextRound();
    }, this.revealMs);
  };

  Host.prototype.readyNext = function (pid) {
    if (this.phase !== 'reveal') return;
    this.ready[pid] = true;
    var humans = this.humans().map(function (p) { return p.id; });
    var allReady = humans.length > 0 && humans.every(function (id) { return this.ready[id]; }, this);
    if (allReady) {
      clearTimeout(this.revealTimer);
      this.nextRound();
    }
  };

  Host.prototype.stop = function () {
    this.started = false;
    this.phase = 'idle';
    clearTimeout(this.timer);
    clearTimeout(this.graceTimer);
    clearTimeout(this.revealTimer);
  };

  global.XianglongHost = Host;
})(typeof window !== 'undefined' ? window : globalThis);
