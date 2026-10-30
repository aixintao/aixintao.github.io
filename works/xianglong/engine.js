/*
 * 降龙 Xianglong —— 规则引擎
 *
 * 纯函数，不碰 DOM、不碰网络。单机、房主、客户端都跑这一份代码：
 * 客户端本地先算一遍做即时反馈，正式结果以房主的结算为准。
 *
 * 规则来源：本地 ClapGame/Gamerule.md，另按原始口述规则修正了两处：
 *   1. 防御阈值是「攻击力 < N 才防得住」，所以 全发(5) 破小防、
 *      九阴(9) 破中防、十八掌(18) 破大防。Godot 原型把 5/9/18 当成了可挡。
 *   2. 中防/大防的连用上限是 5 次和 4 次（「不能连续出第 5 次 / 第 4 次」）。
 *      第 5 次中防、第 4 次大防本身仍然生效，第 6 次 / 第 5 次才判犯规。
 */
(function (global) {
  'use strict';

  var SKILLS = {
    charge:    { name: '降龙',       short: '降', kind: 'charge', gain: 1, block: 0, hint: '回 1 气，无防备' },
    def_small: { name: '小防',       short: '小', kind: 'defend', block: 4,  hint: '挡 1–4' },
    def_mid:   { name: '中防',       short: '中', kind: 'defend', block: 8,  limit: 5, hint: '挡 5–8，最多连 5 次' },
    def_big:   { name: '大防',       short: '大', kind: 'defend', block: 17, limit: 4, hint: '挡 9–17，最多连 4 次' },
    atk_1:     { name: '单掌',       short: '单', kind: 'attack', cost: 1,  power: 1,  hint: '耗 1' },
    atk_2:     { name: '双掌',       short: '双', kind: 'attack', cost: 2,  power: 2,  hint: '耗 2' },
    atk_3:     { name: '三连',       short: '三', kind: 'attack', cost: 3,  power: 3,  hint: '耗 3' },
    atk_5:     { name: '全发',       short: '全', kind: 'attack', cost: 5,  power: 5,  hint: '耗 5，破小防' },
    atk_6:     { name: '六脉',       short: '六', kind: 'attack', cost: 6,  power: 6,  hint: '耗 6' },
    atk_9:     { name: '九阴',       short: '九', kind: 'attack', cost: 9,  power: 9,  hint: '耗 9，破中防' },
    atk_18:    { name: '降龙十八掌', short: '十八', kind: 'attack', cost: 18, power: 18, hint: '耗 18，破大防' }
  };

  var ATTACKS = ['atk_1', 'atk_2', 'atk_3', 'atk_5', 'atk_6', 'atk_9', 'atk_18'];
  var DEFENDS = ['def_small', 'def_mid', 'def_big'];

  function skill(id) { return Object.prototype.hasOwnProperty.call(SKILLS, id) ? SKILLS[id] : null; }

  function newPlayer(o) {
    o = o || {};
    return {
      id: o.id,
      name: o.name || o.id,
      isCpu: !!o.isCpu,
      level: o.level == null ? 1 : o.level,
      energy: 0,
      alive: true,
      defMidStreak: 0,
      defBigStreak: 0,
      action: null,
      target: null
    };
  }

  /* 从「当前状态」出发能不能选这一招。UI 置灰、AI 过滤共用。 */
  function canChoose(p, skillId, playerCount) {
    var s = skill(skillId);
    if (!p || !s || !p.alive) return false;
    if (s.kind !== 'attack') return true;
    if (p.energy < s.cost) return false;
    return playerCount == null || playerCount >= 2;
  }

  /* 这一招用下去会不会触发犯规（本回合作废）。 */
  function willFoul(p, skillId) {
    var s = skill(skillId);
    if (!p || !s || s.kind !== 'defend') return false;
    if (skillId === 'def_mid') return p.defMidStreak + 1 > s.limit;
    if (skillId === 'def_big') return p.defBigStreak + 1 > s.limit;
    return false;
  }

  function foulReason(id, why) {
    if (why === 'energy') return '能量不足';
    if (why === 'target') return '目标无效';
    return id === 'def_mid' ? '中防连用超限' : '大防连用超限';
  }

  /**
   * 并发结算一个回合。
   * players 是本回合开始的快照，带 action / target。
   * opts.forced = { pid: 'charge' }，超时未提交者的默认指令（不传则是正常出招）
   *
   * 一轮只在所有人都亮过招之后才结算，所以这里的 events 是全公开的：
   * 规则里「同时出手、一起结算」本来就不藏着谁打了谁。
   */
  function resolve(players, opts) {
    opts = opts || {};
    var forced = opts.forced || {};

    var st = players.map(function (p) {
      return {
        id: p.id, name: p.name, isCpu: p.isCpu, level: p.level,
        energy: p.energy, alive: p.alive,
        defMidStreak: p.defMidStreak || 0, defBigStreak: p.defBigStreak || 0,
        wasAlive: p.alive,
        action: p.action, target: p.target,
        order: null
      };
    });
    var byId = {};
    st.forEach(function (p) { byId[p.id] = p; });

    var ev = [];
    var attacks = [];
    var clashes = {};   // 'A>B' -> 'win' | 'lose' | 'draw'

    // ---------- 阶段一：合法性校验（只定招，不结算） ----------
    // 犯规在这一层就降级成降龙，且这回合不回气（原地发呆）。
    // 直接把 p.order 写回，后面的扣费、对波、格挡全看它。
    st.forEach(function (p) {
      if (!p.alive) { p.order = { action: 'none', target: null, foul: null }; return; }
      var raw = forced[p.id] ? { action: forced[p.id], target: null } : { action: p.action, target: p.target };
      var s = skill(raw.action);
      var id = s ? raw.action : 'charge';
      s = SKILLS[id];
      var foul = null;

      if (s.kind === 'attack') {
        var tgt = byId[raw.target];
        if (!tgt || tgt === p || !tgt.alive) foul = 'target';
        else if (p.energy < s.cost) foul = 'energy';
      } else if (s.kind === 'defend') {
        if (willFoul(p, id)) foul = 'limit';
      }

      if (foul) {
        ev.push({ t: 'foul', p: p.id, skill: id, why: foul, text: foulReason(id, foul), punish: 'degrade' });
        p.order = { action: 'charge', target: null, foul: { skill: id, why: foul } };
        p.defMidStreak = 0;
        p.defBigStreak = 0;
        return;
      }
      p.order = { action: id, target: s.kind === 'attack' ? raw.target : null, foul: null, block: s.block || 0 };
    });

    // 扣费、防御连用计数（回气留到处决之后，只给活到回合末的降龙）
    st.forEach(function (p) {
      if (!p.alive || !p.order) return;
      var s = SKILLS[p.order.action];
      if (s.kind === 'attack') p.energy -= s.cost;
      p.defMidStreak = p.order.action === 'def_mid' ? p.defMidStreak + 1 : 0;
      p.defBigStreak = p.order.action === 'def_big' ? p.defBigStreak + 1 : 0;
      if (s.kind === 'attack') {
        attacks.push({ a: p, power: s.power, skill: s, target: byId[p.order.target], dir: p.id + '>' + p.order.target });
      }
    });

    // ---------- 阶段二：对波（仅限两两互指） ----------
    // A 打 B 且 B 打 A 才算对波；A→B→C→A 的环不算，按背刺处理。
    attacks.forEach(function (atk) {
      var dir = atk.dir, back = atk.target.id + '>' + atk.a.id;
      if (clashes[dir] || clashes[back]) return;
      var theirs = null;
      for (var i = 0; i < attacks.length; i++) if (attacks[i].dir === back) { theirs = attacks[i]; break; }
      if (!theirs) return;
      if (atk.power > theirs.power) {
        clashes[dir] = 'win'; clashes[back] = 'lose';
        ev.push({ t: 'clash', winner: atk.a.id, loser: atk.target.id, winPower: atk.power, losePower: theirs.power });
      } else if (atk.power < theirs.power) {
        clashes[dir] = 'lose'; clashes[back] = 'win';
        ev.push({ t: 'clash', winner: atk.target.id, loser: atk.a.id, winPower: theirs.power, losePower: atk.power });
      } else {
        clashes[dir] = 'draw'; clashes[back] = 'draw';
        ev.push({ t: 'clash_draw', a: atk.a.id, d: atk.target.id, power: atk.power });
      }
    });

    // ---------- 阶段三：逐刀判定 ----------
    var doomed = {};
    function markDead(id) { doomed[id] = true; }

    // 对波输的一方直接出局
    Object.keys(clashes).forEach(function (dir) {
      if (clashes[dir] !== 'lose') return;
      markDead(dir.split('>')[0]);
    });

    attacks.forEach(function (atk) {
      var a = atk.a, tgt = atk.target;
      var dir = atk.dir;
      if (!tgt || !tgt.alive) return;

      if (clashes[dir] === 'win') return;           // 对波赢下，刀不再落到对方身上
      if (clashes[dir] === 'draw') {                 // 战力相同，互相抵消
        ev.push({ t: 'clash_skip', a: a.id, d: tgt.id });
        return;
      }
      // 对波输了：双方的对砍已经分出胜负，这一刀不再结算到赢家身上。
      // （被第三人背刺时打出的那一刀仍然生效——那走的是下面 tKind === 'attack' 的分支，
      //   因为那几刀根本没进入对波。）
      if (clashes[dir] === 'lose') return;

      var tOrder = tgt.order;
      var tKind = tOrder ? SKILLS[tOrder.action].kind : 'charge';

      if (tKind !== 'attack' && tKind !== 'defend') {
        // 在攒气（或没定招、或犯规作废成降龙）：没有任何防御
        if (tOrder && tOrder.foul) ev.push({ t: 'foul_hit', a: a.id, d: tgt.id, skill: atk.skill.name, power: atk.power, foul: tOrder.foul });
        else ev.push({ t: 'open_hit', a: a.id, d: tgt.id, skill: atk.skill.name, power: atk.power });
        markDead(tgt.id);
        return;
      }

      if (tKind === 'attack') {
        // 对方在攻击（且不是互指）：背刺
        ev.push({ t: 'backstab', a: a.id, d: tgt.id, skill: atk.skill.name, power: atk.power });
        markDead(tgt.id);
        return;
      }

      // 对方是防守。防守没犯规，按格挡值判定。
      if (atk.power > tOrder.block) {
        ev.push({ t: 'break', a: a.id, d: tgt.id, skill: atk.skill.name, power: atk.power, block: tOrder.block, def: SKILLS[tOrder.action].name });
        markDead(tgt.id);
      } else {
        ev.push({ t: 'block', a: a.id, d: tgt.id, skill: atk.skill.name, power: atk.power, block: tOrder.block, def: SKILLS[tOrder.action].name });
      }
    });

    // ---------- 阶段四：处决 ----------
    st.forEach(function (p) {
      if (p.wasAlive && doomed[p.id] && p.alive) {
        p.alive = false;
        ev.push({ t: 'dead', p: p.id });
      } else if (p.wasAlive && doomed[p.id]) {
        p.alive = false;
      }
    });

    // 回气：活到回合末、且这回合是降龙的人
    st.forEach(function (p) {
      if (!p.alive || !p.order) return;
      var s = SKILLS[p.order.action];
      if (s.kind === 'charge') {
        p.energy += s.gain;
        ev.push({ t: 'gain', p: p.id, gain: s.gain, energy: p.energy });
      }
    });

    // ---------- 结果 ----------
    var aliveIds = st.filter(function (p) { return p.alive; }).map(function (p) { return p.id; });
    var out = {
      players: st.map(function (p) {
        return {
          id: p.id, name: p.name, isCpu: p.isCpu, level: p.level,
          energy: p.energy, alive: p.alive,
          defMidStreak: p.defMidStreak, defBigStreak: p.defBigStreak,
          action: p.order ? p.order.action : p.action,
          target: p.order ? p.order.target : p.target,
          foul: p.order ? p.order.foul : null,
          died: p.wasAlive && !p.alive
        };
      }),
      events: ev,
      deaths: st.filter(function (p) { return p.wasAlive && !p.alive; }).map(function (p) { return p.id; }),
      alive: aliveIds,
      winner: aliveIds.length === 1 ? aliveIds[0] : null,
      draw: aliveIds.length === 0
    };
    return out;
  }

  function aliveOthers(players, selfId) {
    return players.filter(function (p) { return p.alive && p.id !== selfId; });
  }

  /* ---------------- AI ---------------- */

  var LEVELS = [
    { id: 0, name: '愣头青', desc: '不读场面，手里有什么就扔什么，偶尔想起来防一下。' },
    { id: 1, name: '熟手',   desc: '看对手最高能量选防御档位，会省气，专挑软柿子。' },
    { id: 2, name: '高手',   desc: '把这一回合的招式挨个推演一遍：活下来的次数、能带走几个人、还剩多少气，挑最好的那手。' }
  ];

  function pickWeighted(list) {
    var total = 0;
    list.forEach(function (it) { total += it.w; });
    if (total <= 0) return list.length ? list[0].k : 'charge';
    var r = Math.random() * total;
    for (var i = 0; i < list.length; i++) { r -= list[i].w; if (r < 0) return list[i].k; }
    return list[list.length - 1].k;
  }

  function maxEnemyEnergy(players, selfId) {
    var m = 0;
    players.forEach(function (p) { if (p.alive && p.id !== selfId && p.energy > m) m = p.energy; });
    return m;
  }

  /* 按对手最高能量，挑「够用且不浪费」的防御档；防不住的档直接不给。 */
  function usefulDefences(maxE, p) {
    var out = [];
    if (maxE <= 0) return out;
    if (maxE <= 4) out = ['def_small'];
    else if (maxE <= 8) out = ['def_mid', 'def_big'];
    else out = ['def_big'];
    return out.filter(function (k) { return !willFoul(p, k); });
  }

  function pickWeakest(others) {
    return others.slice().sort(function (x, y) { return x.energy - y.energy; })[0].id;
  }

  function aiLv0(p, players) {
    var others = aliveOthers(players, p.id);
    var opts = [{ k: 'charge', w: 50 }];
    ATTACKS.forEach(function (k) { if (p.energy >= SKILLS[k].cost) opts.push({ k: k, w: 15 }); });
    DEFENDS.forEach(function (k) { if (!willFoul(p, k)) opts.push({ k: k, w: 5 }); });
    var k = pickWeighted(opts);
    return { action: k, target: SKILLS[k].kind === 'attack' ? others[Math.floor(Math.random() * others.length)].id : null };
  }

  function aiLv1(p, players) {
    var others = aliveOthers(players, p.id);
    if (!others.length) return { action: 'charge', target: null };
    var maxE = maxEnemyEnergy(players, p.id);
    var opts = [];

    opts.push({ k: 'charge', w: maxE === 0 ? 70 : p.energy === 0 ? 60 : p.energy < 5 ? 28 : 20 });
    usefulDefences(maxE, p).forEach(function (k) { opts.push({ k: k, w: 18 }); });

    ATTACKS.forEach(function (k) {
      var s = SKILLS[k];
      if (p.energy < s.cost) return;
      var w = p.energy < 5 ? 10 / s.power : 4 + s.power * 1.2;
      if (maxE === 0) w *= 0.2;
      if (maxE >= 5 && p.energy - s.cost < 1) w *= 0.35; // 别把气打空
      if (w > 0) opts.push({ k: k, w: w });
    });

    var k = pickWeighted(opts);
    var target = null;
    if (SKILLS[k].kind === 'attack') {
      target = pickWeakest(others);
      var ripe = others.filter(function (o) { return o.energy === 0; });
      if (ripe.length && SKILLS[k].power >= 5 && Math.random() < 0.7) target = ripe[0].id;
    }
    return { action: k, target: target };
  }

  /*
   * 高手：把这一回合的所有招式各试一遍。
   *
   * 对手下一招没法知道，就按「他大概怎么想」抽几份样本出来（用熟手的思路，
   * 高手自己也当成熟手来估），每种出招在每个样本里各结算一次，看活下来几次、
   * 打掉几个人、剩多少气，挑总分最高的。这样它自然学会了卡对波、躲大招、
   * 抓对手攒气的空档。
   *
   * 回合开局时场上信息很少、各家招式都还没定，算下来很多招都差不多；
   * 气越多，选择才开始分化。所以留一成多的概率随手走一步，免得它像开了天眼。
   */
  var LV2_SAMPLES = 8;
  var LV2_BLUNDER = 0.15;

  function lv2Candidates(p, others) {
    var out = [{ action: 'charge', target: null }];
    DEFENDS.forEach(function (k) {
      if (!willFoul(p, k)) out.push({ action: k, target: null });
    });
    ATTACKS.forEach(function (k) {
      var s = SKILLS[k];
      if (p.energy < s.cost) return;
      others.forEach(function (o) { out.push({ action: k, target: o.id }); });
    });
    return out;
  }

  function aiLv2(p, players) {
    var others = aliveOthers(players, p.id);
    if (!others.length) return { action: 'charge', target: null };

    // 攒到 18 气、场上没人也攒到 18：大防都挡不住，这一掌没有风险，直接收人头。
    var unchecked = players.every(function (x) {
      return x.id === p.id || !x.alive || x.energy < 18;
    });
    if (p.energy >= 18 && unchecked) return { action: 'atk_18', target: pickWeakest(others) };

    // 对手样本：用熟手的思路，各抽一招
    var samples = [];
    for (var s = 0; s < LV2_SAMPLES; s++) {
      var acts = {};
      others.forEach(function (o) {
        acts[o.id] = aiLv1({
          id: o.id, name: o.name, isCpu: true, level: 1,
          energy: o.energy, alive: true,
          defMidStreak: o.defMidStreak || 0, defBigStreak: o.defBigStreak || 0
        }, players);
      });
      samples.push(acts);
    }

    var best = null, bestScore = -Infinity;
    var cands = lv2Candidates(p, others);
    cands.forEach(function (c) {
      var survive = 0, kills = 0, energy = 0;
      for (var s = 0; s < LV2_SAMPLES; s++) {
        var snap = players.map(function (x) {
          if (x.id === p.id) return Object.assign({}, x, { action: c.action, target: c.target });
          if (!x.alive) return Object.assign({}, x, { action: 'charge', target: null });
          var a = samples[s][x.id];
          return Object.assign({}, x, { action: a.action, target: a.target });
        });
        var r = resolve(snap, {});
        var me = null;
        for (var i = 0; i < r.players.length; i++) if (r.players[i].id === p.id) me = r.players[i];
        if (me.alive) survive += 1;
        r.players.forEach(function (x) { if (x.id !== p.id && x.died) kills += 1; });
        energy += me.energy;
      }
      var score = survive * 3 + kills * 0.6 + (energy / LV2_SAMPLES) * 0.05;
      if (score > bestScore) { bestScore = score; best = c; }
    });
    if (Math.random() < LV2_BLUNDER) {
      return cands[Math.floor(Math.random() * cands.length)] || { action: 'charge', target: null };
    }
    return best || { action: 'charge', target: null };
  }

  function aiDecide(p, players) {
    var lv = p.level || 0;
    var order = lv >= 2 ? aiLv2(p, players) : lv === 1 ? aiLv1(p, players) : aiLv0(p, players);
    var s = skill(order.action);
    if (!s) order = { action: 'charge', target: null };
    s = SKILLS[order.action];
    if (s.kind === 'attack') {
      if (p.energy < s.cost) order = { action: 'charge', target: null };
      else if (!order.target) order.target = aliveOthers(players, p.id)[0].id;
    }
    if (willFoul(p, order.action)) order = { action: 'charge', target: null };
    return order;
  }

  var api = {
    SKILLS: SKILLS, ATTACKS: ATTACKS, DEFENDS: DEFENDS, LEVELS: LEVELS,
    skill: skill, newPlayer: newPlayer, canChoose: canChoose, willFoul: willFoul,
    resolve: resolve, aiDecide: aiDecide, aliveOthers: aliveOthers
  };

  global.Xianglong = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
