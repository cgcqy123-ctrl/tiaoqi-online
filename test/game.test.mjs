// 中国跳棋对局状态机单元测试（零依赖，纯 node）：node test/game.test.mjs
// 风格对齐五子棋/象棋项目 test/：problems 收集 + ✅/❌ + process.exit(1)
import assert from 'node:assert/strict';
import * as R from '../js/rules.js';
import { Game, PHASE, sideOfSeat, seatOfSide } from '../js/game.js';

const problems = [];
let passed = 0;
const t = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('❌ ' + name);
    problems.push(name + '：' + (e && e.message ? e.message : String(e)));
  }
};

const emptyBoard = () => new Array(R.SIZE).fill(null);
const newGame = () => new Game([{ name: '甲' }, { name: '乙' }]).start();
const coord = (id) => id + '(q' + R.HOLES[id].q + ',r' + R.HOLES[id].r + ')';

/** 某一方全部合法走法（[{from,to,path}]） */
function movesOf(board, side) {
  const out = [];
  for (let i = 0; i < R.SIZE; i++) {
    if (board[i] !== side) continue;
    for (const m of R.legalMoves(board, i)) out.push({ from: i, to: m.to, path: m.path });
  }
  return out;
}

/** 直接摆一个局面（单元测试专用） */
function setup(board, turn = R.RED) {
  const g = newGame();
  g.board = board.slice();
  g.turn = turn;
  return g;
}

/**
 * 构造「9 子已在目标营 + 第 10 子紧挨着空位」的入营胜利局面。
 * goalIds: 该方目标营；homeIds: 该方出发营（对手的子不放在里面）。
 */
function nearWinSetup(goalIds, homeIds, side, otherSide) {
  let goalHole = -1;
  let from = -1;
  outer: for (const id of goalIds) {
    const h = R.HOLES[id];
    for (const [dq, dr] of R.DIRS) {
      const nb = R.holeAt(h.q + dq, h.r + dr);
      if (nb < 0 || goalIds.includes(nb)) continue;
      goalHole = id;
      from = nb;
      break outer;
    }
  }
  assert.ok(goalHole >= 0 && from >= 0, '应能构造入营胜利局面');
  const board = emptyBoard();
  for (const id of goalIds) board[id] = side;
  board[goalHole] = null;
  board[from] = side;
  let placed = 0;
  for (let i = 0; i < R.SIZE && placed < 10; i++) {
    if (board[i] !== null || homeIds.includes(i) || goalIds.includes(i)) continue;
    board[i] = otherSide;
    placed++;
  }
  return { board, from, goalHole };
}

/** 固定种子的伪随机（与五子棋测试同款） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- 开局 ---------------- */

t('开局：红方先行，座位映射与玩家信息', () => {
  assert.equal(PHASE.LOBBY, 'lobby');
  assert.equal(PHASE.PLAY, 'play');
  assert.equal(PHASE.OVER, 'over');
  assert.equal(sideOfSeat(0), 'r');
  assert.equal(sideOfSeat(1), 'b');
  assert.equal(sideOfSeat(-1), null);
  assert.equal(sideOfSeat(2), null);
  assert.equal(seatOfSide('r'), 0);
  assert.equal(seatOfSide('b'), 1);

  const g = new Game([{ name: '甲' }, { name: '乙' }]);
  assert.equal(g.phase, PHASE.LOBBY);
  assert.equal(g.round, 0, '还没开局');
  assert.equal(g.turn, 'r', '默认轮到红方');
  assert.deepEqual(g.history, []);
  assert.equal(g.players.length, 2);
  assert.deepEqual(
    g.players.map((p) => [p.seat, p.side, p.name, p.connected]),
    [[0, 'r', '甲', true], [1, 'b', '乙', true]]
  );
  assert.deepEqual(g.player(0), { seat: 0, side: 'r', name: '甲', connected: true });
  assert.equal(g.player(5), null);

  g.start();
  assert.equal(g.phase, PHASE.PLAY);
  assert.equal(g.round, 1);
  assert.equal(g.turn, 'r');
  assert.equal(g.board.length, 121);
  assert.equal(g.board.join(','), R.initialBoard().join(','));
  assert.ok(g.startedAt > 0);
  assert.equal(g.plyCount, 0);

  const d = new Game();
  assert.deepEqual(d.players.map((p) => p.name), ['玩家1', '玩家2'], '缺省昵称');
  const e = new Game([{ name: '甲', connected: false }, { name: '乙' }]);
  assert.equal(e.players[0].connected, false);
  assert.equal(e.players[1].connected, true);
});

/* ---------------- 走一步 / 跳 / 连跳 ---------------- */

t('走一步：记谱、轮转、历史与 lastMove', () => {
  const g = newGame();
  const res = g.move(0, 111, [111, 103]);
  assert.deepEqual(res, { ok: true, over: false, notation: '走 1 步' });
  assert.equal(g.board[111], null);
  assert.equal(g.board[103], 'r');
  assert.equal(g.turn, 'b');
  assert.deepEqual(g.lastMove, { from: 111, path: [111, 103] });
  assert.equal(g.plyCount, 1);
  assert.deepEqual(g.history, [{ ply: 1, side: 'r', from: 111, path: [111, 103], notation: '走 1 步', jumps: 0 }]);
  const v = g.view(0);
  assert.equal(v.moves.length, 1);
  assert.deepEqual(v.moves[0], { ply: 1, side: 'r', from: 111, path: [111, 103], notation: '走 1 步', jumps: 0 });

  // 蓝方接着走：3→16 是一次跳
  const res2 = g.move(1, 3, [3, 16]);
  assert.equal(res2.over, false);
  assert.equal(res2.notation, '跳 1 下');
  assert.equal(g.turn, 'r');
  assert.equal(g.plyCount, 2);
  assert.equal(g.history[1].side, 'b');
  assert.equal(g.history[1].jumps, 1);
});

t('跳与连跳：记谱 / jumps / 盘面更新', () => {
  const b = emptyBoard();
  b[60] = 'r'; // 中心
  b[51] = 'b'; // 60→41 的中间子
  const g = setup(b);
  assert.deepEqual(g.move(0, 60, [60, 41]), { ok: true, over: false, notation: '跳 1 下' });
  assert.equal(g.history[0].jumps, 1);
  assert.equal(g.board[60], null);
  assert.equal(g.board[41], 'r');
  assert.equal(g.turn, 'b');

  const b2 = emptyBoard();
  b2[60] = 'r';
  b2[51] = 'b';
  b2[30] = 'r'; // 41→18 的中间子
  const g2 = setup(b2);
  const res = g2.action(0, { type: 'move', from: 60, path: [60, 41, 18] });
  assert.deepEqual(res, { ok: true, over: false, notation: '跳 2 下' });
  assert.equal(g2.history[0].jumps, 2);
  assert.equal(g2.board[18], 'r');
  assert.equal(g2.board[60], null);
  assert.deepEqual(g2.view(0).lastMove, { from: 60, path: [60, 41, 18] });

  // 也可以跳过自己的棋子
  const b3 = emptyBoard();
  b3[60] = 'r';
  b3[51] = 'r';
  const g3 = setup(b3);
  assert.equal(g3.move(0, 60, [60, 41]).notation, '跳 1 下');
});

t('move 会拷贝 path，调用方改数组不影响历史', () => {
  const g = newGame();
  const path = [111, 103];
  g.move(0, 111, path);
  path.push(999);
  path[1] = 999;
  assert.deepEqual(g.history[0].path, [111, 103]);
  assert.deepEqual(g.lastMove.path, [111, 103]);
  assert.deepEqual(g.view(0).moves[0].path, [111, 103]);
});

/* ---------------- 非法动作 ---------------- */

t('未开局 / 三无起点 / 轮次 / 路径错误都会抛中文错误', () => {
  assert.throws(() => new Game([{ name: '甲' }, { name: '乙' }]).move(0, 111, [111, 103]), /对局还没开始或已经结束/);
  const g = newGame();
  assert.throws(() => g.move(1, 3, [3, 16]), /还没轮到你走棋/, '红先，蓝方不能先走');
  assert.throws(() => g.move(-1, 111, [111, 103]), /观战不能走棋/);
  assert.throws(() => g.move(2, 111, [111, 103]), /观战不能走棋/, '没有 2 号座位');
  assert.throws(() => g.move(0, -1, [111, 103]), /走法无效/);
  assert.throws(() => g.move(0, 121, [0, 1]), /走法无效/);
  assert.throws(() => g.move(0, 1.5, [1, 2]), /走法无效/);
  assert.throws(() => g.move(0, NaN, [111, 103]), /走法无效/);
  assert.throws(() => g.move(0, 60, [60, 61]), /这里没有棋子/);
  assert.throws(() => g.move(0, 111, null), /走法无效/);
  assert.throws(() => g.move(0, 111, []), /这步棋走不通/);
  assert.throws(() => g.move(0, 111, [111, 999]), /这步棋走不通/);
  assert.throws(() => g.move(0, 111, [112, 103]), /这步棋走不通/);
  assert.throws(() => g.move(0, 111, [111, 112]), /落点已经有棋子了/, '落点被占');

  // 走一步 + 跳混合的伪装路径
  const mix = emptyBoard();
  mix[111] = 'r';
  mix[115] = 'b'; // 112→? 这里只验证混合路径被拒
  const gm = setup(mix);
  assert.throws(() => gm.move(0, 111, [111, 112, 102]), /这步棋走不通/);

  // 结束后不能再走 / 不能认输
  const over = newGame();
  over.resign(1);
  assert.throws(() => over.move(0, 111, [111, 103]), /对局还没开始或已经结束/);
  assert.throws(() => over.resign(0), /对局已经结束/);
});

t('有未答复的请求时不能走棋', () => {
  const g = newGame();
  g.move(0, 111, [111, 103]);
  g.requestUndo(0);
  assert.throws(() => g.move(1, 3, [3, 16]), /先处理还没答复的悔棋 \/ 求和请求/);
  g.replyUndo(1, false);
  g.offerDraw(0);
  assert.throws(() => g.move(1, 3, [3, 16]), /先处理还没答复的悔棋 \/ 求和请求/);
  g.replyDraw(1, false);
  assert.equal(g.move(1, 3, [3, 16]).ok, true, '拒绝后可以继续走');
});

/* ---------------- 观战限制 ---------------- */

t('观战限制：不能走棋 / 认输 / 求和 / 悔棋 / 回应请求', () => {
  const g = newGame();
  assert.throws(() => g.move(-1, 111, [111, 103]), /观战不能走棋/);
  assert.throws(() => g.resign(-1), /观战不能认输/);
  assert.throws(() => g.offerDraw(-1), /观战不能求和/);
  assert.throws(() => g.requestUndo(-1), /观战不能悔棋/);
  assert.equal(g.canRequestUndo(-1), false);

  g.move(0, 111, [111, 103]);
  g.requestUndo(0);
  assert.throws(() => g.replyUndo(-1, true), /观战不能回应悔棋/);
  g.replyUndo(1, false);
  g.offerDraw(0);
  assert.throws(() => g.replyDraw(-1, true), /观战不能回应求和/);
  g.replyDraw(1, false);

  const vs = g.view(-1);
  assert.equal(vs.seat, -1);
  assert.equal(vs.spectator, true);
  assert.equal(vs.mySide, null);
  assert.equal(vs.canUndo, false);
});

/* ---------------- 入营获胜 ---------------- */

t('入营获胜：红方补满目标营', () => {
  const { board, from, goalHole } = nearWinSetup(R.HOME_TOP, R.HOME_BOTTOM, R.RED, R.BLUE);
  assert.equal(R.inGoal(board, R.RED), 9, '构造局面红方 9 子已入营');
  assert.ok(R.isStep([from, goalHole]), '最后一手是走一步');
  const g = setup(board, R.RED);
  const res = g.move(0, from, [from, goalHole]);
  assert.deepEqual(res, { ok: true, over: true, notation: '走 1 步' });
  assert.equal(g.phase, PHASE.OVER);
  assert.deepEqual(g.result, { winner: 'r', reason: 'home', text: '红方胜（全部入营）', plies: 1 });
  assert.deepEqual(R.detectWin(g.board), { side: 'r' });
  assert.deepEqual(g.view(0).goalCount, { r: 10, b: 0 });
  assert.equal(g.view(-1).result.winner, 'r');
  assert.throws(() => g.move(1, goalHole, [goalHole, from]), /对局还没开始或已经结束/);
  assert.throws(() => g.resign(1), /对局已经结束/);
});

t('入营获胜：蓝方补满目标营', () => {
  const { board, from, goalHole } = nearWinSetup(R.HOME_BOTTOM, R.HOME_TOP, R.BLUE, R.RED);
  assert.equal(R.inGoal(board, R.BLUE), 9, '构造局面蓝方 9 子已入营');
  const g = setup(board, R.BLUE);
  const res = g.move(1, from, [from, goalHole]);
  assert.equal(res.over, true);
  assert.equal(g.phase, PHASE.OVER);
  assert.equal(g.result.winner, 'b');
  assert.equal(g.result.reason, 'home');
  assert.equal(g.result.text, '蓝方胜（全部入营）');
  assert.deepEqual(g.view(1).goalCount, { r: 0, b: 10 });
});

t('只有 9 子入营时不判胜', () => {
  const b = emptyBoard();
  for (const id of R.HOME_TOP) b[id] = R.RED;
  b[R.HOME_TOP[9]] = null; // 目标营最后一个空位
  b[60] = R.RED; // 另有一颗红子在中心
  const g = setup(b, R.RED);
  assert.equal(R.inGoal(b, R.RED), 9);
  const move = R.legalMoves(b, 60).find((m) => !R.HOME_TOP.includes(m.to));
  assert.ok(move, '中心红子有非入营的走法');
  const res = g.move(0, 60, move.path);
  assert.equal(res.over, false);
  assert.equal(g.phase, PHASE.PLAY);
  assert.equal(g.result, null);
  assert.deepEqual(g.view(0).goalCount, { r: 9, b: 0 });
});

/* ---------------- 悔棋 ---------------- */

t('悔棋：刚走完对面没应，只退 1 手', () => {
  const g = newGame();
  const initial = g.board.join(',');
  g.move(0, 111, [111, 103]);
  assert.equal(g.view(0).canUndo, true, '刚走完也能申请悔棋');
  assert.equal(g.view(1).canUndo, false, '蓝方还没走过棋');
  assert.deepEqual(g.requestUndo(0), { ok: true });
  assert.equal(g.view(0).offers.undo, 0);
  assert.equal(g.view(1).offers.undo, 0);
  assert.equal(g.canRequestUndo(0), false, '请求挂起时不能再申请');
  assert.throws(() => g.replyUndo(0, true), /不能自己答应自己/);
  const r = g.replyUndo(1, true);
  assert.deepEqual(r, { ok: true, over: false, accepted: true, popped: 1 });
  assert.equal(g.plyCount, 0);
  assert.equal(g.turn, 'r');
  assert.equal(g.board.join(','), initial);
  assert.equal(g.lastMove, null);
  assert.equal(g.view(0).offers.undo, null);
});

t('悔棋：对面已应招则退 2 手', () => {
  const g = newGame();
  const initial = g.board.join(',');
  g.move(0, 111, [111, 103]);
  g.move(1, 3, [3, 16]); // 蓝方跳 1 下
  assert.equal(g.turn, 'r');
  g.requestUndo(0);
  const r = g.replyUndo(1, true);
  assert.equal(r.popped, 2);
  assert.equal(g.plyCount, 0);
  assert.equal(g.turn, 'r');
  assert.equal(g.board.join(','), initial);
  assert.equal(g.lastMove, null);
});

t('悔棋：多手后回到自己上一步之前，保留前面的手', () => {
  const g = newGame();
  const plies = [];
  for (let i = 0; i < 4; i++) {
    const side = g.turn;
    const m = movesOf(g.board, side)[0];
    plies.push({ side, from: m.from, path: m.path });
    g.action(side === 'r' ? 0 : 1, { type: 'move', from: m.from, path: m.path });
  }
  // 单独跑前两手，拿到「悔棋后应回到的盘面」
  const half = newGame();
  for (let i = 0; i < 2; i++) {
    const side = half.turn;
    const m = movesOf(half.board, side)[0];
    half.action(side === 'r' ? 0 : 1, { type: 'move', from: m.from, path: m.path });
  }
  const boardAfter2 = half.board.join(',');

  assert.equal(g.turn, 'r');
  g.requestUndo(0);
  const r = g.replyUndo(1, true);
  assert.equal(r.popped, 2);
  assert.equal(g.plyCount, 2);
  assert.equal(g.turn, 'r');
  assert.equal(g.board.join(','), boardAfter2);
  assert.deepEqual(g.lastMove, { from: plies[1].from, path: plies[1].path });
});

t('悔棋：拒绝则局面不变', () => {
  const g = newGame();
  g.move(0, 111, [111, 103]);
  g.move(1, 3, [3, 16]);
  g.requestUndo(0);
  const board = g.board.join(',');
  const hist = JSON.stringify(g.history);
  const r = g.replyUndo(1, false);
  assert.deepEqual(r, { ok: true, over: false, accepted: false });
  assert.equal(g.board.join(','), board);
  assert.equal(JSON.stringify(g.history), hist);
  assert.equal(g.phase, PHASE.PLAY);
  assert.equal(g.view(0).offers.undo, null);
  const nextRed = movesOf(g.board, 'r')[0];
  assert.equal(g.move(0, nextRed.from, nextRed.path).ok, true, '拒绝后可以正常继续');
});

t('悔棋限制：未走棋 / 无请求 / 重复请求 / 结束后', () => {
  const g = newGame();
  assert.equal(g.view(1).canUndo, false);
  assert.throws(() => g.requestUndo(0), /你还没走过棋，没有可悔的/);
  g.move(0, 111, [111, 103]);
  assert.throws(() => g.requestUndo(1), /你还没走过棋，没有可悔的/, '蓝方还没走过棋');
  assert.throws(() => g.replyUndo(1, true), /没有待回应的悔棋请求/);
  g.requestUndo(0);
  assert.throws(() => g.requestUndo(0), /已经有一个悔棋请求在等回应/);
  assert.equal(g.canRequestUndo(0), false);
  g.replyUndo(1, false);
  assert.equal(g.canRequestUndo(0), true, '拒绝后恢复可悔棋');

  const over = newGame();
  over.resign(0);
  assert.throws(() => over.requestUndo(0), /对局已经结束/);
  assert.equal(over.canRequestUndo(0), false);
});

/* ---------------- 求和 ---------------- */

t('求和：请求 / 拒绝 / 同意 / 不能自己答应', () => {
  const g = newGame();
  g.move(0, 111, [111, 103]);
  assert.deepEqual(g.offerDraw(0), { ok: true });
  assert.deepEqual(g.view(1).offers, { undo: null, draw: 0 });
  assert.throws(() => g.replyDraw(0, true), /不能自己答应自己/);
  const r = g.replyDraw(1, false);
  assert.deepEqual(r, { ok: true, over: false, accepted: false });
  assert.equal(g.phase, PHASE.PLAY);
  assert.equal(g.view(0).offers.draw, null);
  g.move(1, 3, [3, 16]); // 拒绝后可以继续走

  const g2 = newGame();
  g2.move(0, 111, [111, 103]);
  g2.offerDraw(1);
  assert.equal(g2.view(0).offers.draw, 1);
  const ok = g2.replyDraw(0, true);
  assert.deepEqual(ok, { ok: true, over: true, accepted: true });
  assert.equal(g2.phase, PHASE.OVER);
  assert.equal(g2.result.winner, null);
  assert.equal(g2.result.reason, 'draw');
  assert.equal(g2.result.text, '和棋（双方同意）');
  assert.deepEqual(g2.view(0).offers, { undo: null, draw: null });

  const g3 = newGame();
  assert.throws(() => g3.replyDraw(0, true), /没有待回应的求和请求/);
  g3.move(0, 111, [111, 103]);
  g3.offerDraw(0);
  assert.throws(() => g3.offerDraw(1), /已经有一个求和请求在等回应/);
  assert.throws(() => g3.requestUndo(0), /先处理求和请求/);
  g3.replyDraw(1, false);
  assert.throws(() => g3.replyDraw(1, true), /没有待回应的求和请求/);
});

/* ---------------- 认输 ---------------- */

t('认输：对方获胜并结束对局', () => {
  const g = newGame();
  g.move(0, 111, [111, 103]);
  assert.deepEqual(g.resign(0), { ok: true, over: true });
  assert.equal(g.phase, PHASE.OVER);
  assert.equal(g.result.winner, 'b');
  assert.equal(g.result.reason, 'resign');
  assert.equal(g.result.text, '蓝方胜（认输）');
  assert.equal(g.result.plies, 1);
  assert.deepEqual(g.view(0).offers, { undo: null, draw: null });
  assert.throws(() => g.resign(1), /对局已经结束/);
  assert.throws(() => g.offerDraw(0), /对局已经结束/);

  const g2 = newGame();
  g2.move(0, 111, [111, 103]);
  g2.resign(1);
  assert.equal(g2.result.winner, 'r');
  assert.equal(g2.result.text, '红方胜（认输）');

  assert.throws(() => new Game().resign(0), /对局已经结束/, '大厅里不能认输');
});

/* ---------------- action 统一入口 ---------------- */

t('action 统一入口：分发与无效操作', () => {
  const g = newGame();
  assert.throws(() => g.action(0, null), /无效操作/);
  assert.throws(() => g.action(0, undefined), /无效操作/);
  assert.throws(() => g.action(0, 'move'), /无效操作/);
  assert.throws(() => g.action(0, {}), /无效操作/);
  assert.throws(() => g.action(0, { type: 'bogus' }), /无效操作/);

  // from / path 走 Number 转换，网络传来的字符串也能走
  const res = g.action(0, { type: 'move', from: '111', path: ['111', '103'] });
  assert.equal(res.notation, '走 1 步');
  assert.deepEqual(g.lastMove, { from: 111, path: [111, 103] });
  assert.throws(() => g.action(1, { type: 'move', from: 'abc', path: [1, 2] }), /走法无效/);
  assert.equal(g.action(1, { type: 'move', from: 3, path: [3, 16] }).notation, '跳 1 下', '蓝方走跳');

  // draw / undo / reply / resign 全走 action
  g.action(0, { type: 'draw' });
  assert.equal(g.view(1).offers.draw, 0);
  assert.deepEqual(g.action(1, { type: 'drawReply', accept: false }), { ok: true, over: false, accepted: false });
  assert.equal(g.action(1, { type: 'undo' }).ok, true, '蓝方已走过棋，可以请求悔棋');
  assert.equal(g.view(0).offers.undo, 1);
  const r = g.action(0, { type: 'undoReply', accept: true });
  assert.equal(r.accepted, true);
  assert.equal(r.popped, 1, '蓝方刚走完只退 1 手');
  assert.equal(g.history.length, 1);
  assert.equal(g.turn, 'b');
  g.action(1, { type: 'resign' });
  assert.equal(g.result.winner, 'r');
});

/* ---------------- 再来一局 ---------------- */

t('再开一局：清空状态并递增 round', () => {
  const g = newGame();
  g.move(0, 111, [111, 103]);
  g.resign(1);
  assert.equal(g.phase, PHASE.OVER);
  const at = g.startedAt;
  g.start();
  assert.equal(g.phase, PHASE.PLAY);
  assert.equal(g.round, 2);
  assert.equal(g.turn, 'r');
  assert.equal(g.plyCount, 0);
  assert.equal(g.result, null);
  assert.equal(g.lastMove, null);
  assert.deepEqual(g.offers, { undo: null, draw: null });
  assert.equal(g.board.join(','), R.initialBoard().join(','));
  assert.ok(g.startedAt >= at);
});

/* ---------------- 视图 ---------------- */

t('view：契约字段完整', () => {
  const g = newGame();
  g.move(0, 111, [111, 103]);
  const v0 = g.view(0);
  const v1 = g.view(1);
  const vs = g.view(-1);
  const keys = ['phase', 'round', 'seat', 'spectator', 'mySide', 'turn', 'board', 'players', 'moves', 'lastMove', 'goalCount', 'offers', 'canUndo', 'result', 'startedAt'];
  assert.deepEqual(Object.keys(v0).sort(), keys.slice().sort());

  assert.equal(v0.phase, 'play');
  assert.equal(v0.round, 1);
  assert.equal(v0.seat, 0);
  assert.equal(v0.spectator, false);
  assert.equal(v0.mySide, 'r');
  assert.equal(v1.seat, 1);
  assert.equal(v1.spectator, false);
  assert.equal(v1.mySide, 'b');
  assert.equal(vs.seat, -1);
  assert.equal(vs.spectator, true);
  assert.equal(vs.mySide, null);

  assert.equal(v0.turn, 'b');
  assert.equal(v0.board.length, 121);
  assert.equal(v0.board[103], 'r');
  assert.equal(v0.players.length, 2);
  for (const p of v0.players) assert.deepEqual(Object.keys(p).sort(), ['connected', 'name', 'seat', 'side']);
  assert.equal(v0.players[0].name, '甲');
  assert.equal(v0.players[0].side, 'r');
  assert.equal(v0.players[1].side, 'b');
  assert.equal(v0.moves.length, 1);
  assert.deepEqual(v0.moves[0], { ply: 1, side: 'r', from: 111, path: [111, 103], notation: '走 1 步', jumps: 0 });
  assert.deepEqual(v0.lastMove, { from: 111, path: [111, 103] });
  assert.deepEqual(v0.goalCount, { r: 0, b: 0 });
  assert.deepEqual(v0.offers, { undo: null, draw: null });
  assert.equal(v0.canUndo, true, '红方走过棋且没人请求');
  assert.equal(v1.canUndo, false, '蓝方还没走过棋');
  assert.equal(vs.canUndo, false);
  assert.equal(v0.result, null);
  assert.ok(v0.startedAt > 0);
});

t('view：副本与内部状态隔离', () => {
  const g = newGame();
  g.move(0, 111, [111, 103]);
  const v = g.view(0);
  v.board[0] = 'r';
  v.moves[0].path.push(999);
  v.players[0].name = '改过';
  v.players.push({});
  v.lastMove.path.push(999);
  v.offers.undo = 1;
  assert.equal(g.board[0], 'b');
  assert.equal(g.history[0].path.length, 2);
  assert.equal(g.players.length, 2);
  assert.equal(g.players[0].name, '甲');
  assert.equal(g.lastMove.path.length, 2);
  assert.deepEqual(g.offers, { undo: null, draw: null });
});

/* ---------------- 随机 200 手不变量 ---------------- */

t('随机 200 手：每手合法、双方各 10 子、回合交替', () => {
  const seeds = [1, 2, 3];
  let sawJump = false;
  let sawMultiJump = false;
  for (const seed of seeds) {
    const rand = rng(seed);
    const g = newGame();
    for (let ply = 0; ply < 200; ply++) {
      const side = g.turn;
      const boardBefore = g.board.slice();
      assert.equal(boardBefore.filter((x) => x === 'r').length, 10, 'seed ' + seed + ' 红方始终 10 子');
      assert.equal(boardBefore.filter((x) => x === 'b').length, 10, 'seed ' + seed + ' 蓝方始终 10 子');
      const ms = movesOf(boardBefore, side);
      assert.ok(ms.length > 0, 'seed ' + seed + ' 第 ' + (ply + 1) + ' 手无棋可走');
      const pick = ms[Math.floor(rand() * ms.length)];
      assert.ok(R.isLegalMove(boardBefore, pick.from, pick.path), '选中的走法必须合法');
      assert.equal(R.hasAnyMove(boardBefore, side), true);

      const res = g.action(side === 'r' ? 0 : 1, { type: 'move', from: pick.from, path: pick.path });
      assert.equal(res.ok, true);
      assert.equal(res.notation, R.moveNotation(pick.path), '记谱与规则一致');
      assert.equal(g.phase === PHASE.OVER, !!res.over);

      // 应用后的盘面 = rules.applyMove
      const applied = R.applyMove(boardBefore, pick.from, pick.path);
      assert.equal(g.board.join(','), applied.board.join(','), '盘面按走法变化');
      assert.equal(g.board.filter((x) => x === 'r').length, 10);
      assert.equal(g.board.filter((x) => x === 'b').length, 10);
      assert.equal(g.turn, R.other(side), '回合交替');
      assert.equal(g.history.length, ply + 1);
      const h = g.history[g.history.length - 1];
      assert.equal(h.ply, ply + 1);
      assert.equal(h.side, side);
      assert.equal(h.from, pick.from);
      assert.deepEqual(h.path, pick.path);
      assert.equal(h.notation, res.notation);
      assert.equal(h.jumps, R.jumpCount(pick.path));
      if (h.jumps > 0) sawJump = true;
      if (h.jumps > 1) sawMultiJump = true;

      const v = g.view(0);
      assert.equal(v.moves.length, g.history.length);
      assert.deepEqual(v.goalCount, { r: R.inGoal(g.board, 'r'), b: R.inGoal(g.board, 'b') });
      assert.deepEqual(v.lastMove, { from: pick.from, path: pick.path });

      if (g.phase === PHASE.PLAY) {
        assert.equal(g.result, null);
        assert.equal(R.detectWin(g.board), null);
        assert.equal(R.hasAnyMove(g.board, g.turn), true, '轮到的一方必须有棋可走');
      } else {
        assert.equal(g.result.reason, 'home');
        assert.deepEqual(R.detectWin(g.board), { side: g.result.winner });
        assert.equal(g.view(0).goalCount[g.result.winner], 10);
        break;
      }
    }
    assert.equal(g.history.length, 200, 'seed ' + seed + ' 应能走满 200 手');
  }
  assert.ok(sawJump, '随机对局里应该出现过跳');
  assert.ok(sawMultiJump, '随机对局里应该出现过连跳');
});

/* ---------------- 汇总 ---------------- */

if (problems.length) {
  console.error('\n❌ 对局状态机测试失败 ' + problems.length + ' 项：\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('✅ 对局状态机通过 ' + passed + ' 项');
