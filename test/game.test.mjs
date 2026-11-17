// 中国跳棋对局状态机单元测试（2-6 人，零依赖，纯 node）：node test/game.test.mjs
// 重点：座位号就是棋子编码（0 是有效棋子/胜者）、多人回合轮转、多人认输/求和/悔棋、
//       winner=-1 表示无胜者、view 的 count/camps/goalCount/offers 结构
// 风格对齐五子棋 test/：problems 收集 + ✅/❌ + process.exit(1)
import assert from 'node:assert/strict';
import * as R from '../js/rules.js';
import { Game, PHASE } from '../js/game.js';

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
const centerId = R.HOLES.find((h) => h.q === 0 && h.r === 0).id;
const coord = (id) => id + '(q' + R.HOLES[id].q + ',r' + R.HOLES[id].r + ')';
const makePlayers = (n) => Array.from({ length: n }, (_, i) => ({ name: 'P' + i }));
const newGame = (n) => new Game(makePlayers(n), n).start();

/** 某一座位全部合法走法（[{from,to,path}]） */
function movesOf(board, seat) {
  const out = [];
  for (let i = 0; i < R.SIZE; i++) {
    if (board[i] !== seat) continue;
    for (const m of R.legalMoves(board, i)) out.push({ from: i, to: m.to, path: m.path });
  }
  return out;
}
/** 直接摆一个局面（单元测试专用） */
function setup(board, turn, count) {
  const g = new Game(makePlayers(count), count).start();
  g.board = board.slice();
  g.turn = turn;
  return g;
}
/**
 * 构造「某座位 9 子已在目标营 + 第 10 子紧挨空位」的入营胜利局面。
 * 其他座位各 10 子放在既不是胜者目标营、也不是他们自己目标营的空孔（避免别人先赢）。
 */
function nearWinSetup(seat, count) {
  const goalIds = R.seatGoalIds(seat, count);
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
  for (const id of goalIds) board[id] = seat;
  board[goalHole] = null;
  board[from] = seat;
  for (let s = 0; s < count; s++) {
    if (s === seat) continue;
    const avoid = new Set(goalIds.concat(R.seatGoalIds(s, count)));
    let placed = 0;
    for (let i = 0; i < R.SIZE && placed < 10; i++) {
      if (board[i] !== null || avoid.has(i)) continue;
      board[i] = s;
      placed++;
    }
    assert.equal(placed, 10, '其他座位的子也放得下');
  }
  return { board, from, goalHole };
}
/** 固定种子伪随机（与五子棋测试同款） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const countOf = (board, seat) => board.filter((x) => x === seat).length;

/* ---------------- 开局 / 构造 ---------------- */

t('开局：2 人局红先，count / camps / players / view 正确', () => {
  assert.equal(PHASE.LOBBY, 'lobby');
  assert.equal(PHASE.PLAY, 'play');
  assert.equal(PHASE.OVER, 'over');

  const g = new Game([{ name: '甲' }, { name: '乙' }], 2);
  assert.equal(g.count, 2);
  assert.deepEqual(g.camps, [0, 3]);
  assert.equal(g.phase, PHASE.LOBBY);
  assert.equal(g.round, 0);
  assert.equal(g.turn, 0, '默认轮到座位 0（红方）');
  assert.deepEqual(g.history, []);
  assert.equal(g.players.length, 2);
  assert.deepEqual(
    g.players.map((p) => [p.seat, p.name, p.connected]),
    [[0, '甲', true], [1, '乙', true]]
  );
  const v = g.view(0);
  assert.equal(v.count, 2);
  assert.deepEqual(v.camps, [0, 3]);
  assert.deepEqual(v.goalCount, [0, 0]);
  assert.equal(v.result, null);

  g.start();
  assert.equal(g.phase, PHASE.PLAY);
  assert.equal(g.round, 1);
  assert.equal(g.turn, 0);
  assert.equal(g.board.join(','), R.initialBoard(2).join(','));
  assert.equal(countOf(g.board, 0), 10);
  assert.equal(countOf(g.board, 1), 10);
  assert.ok(g.startedAt > 0);
  assert.equal(g.plyCount, 0);
});

t('2-6 人构造：人数 / 营 / 棋子数 / 玩家名', () => {
  for (const n of R.PLAYER_COUNTS) {
    const g = new Game(makePlayers(n), n);
    assert.equal(g.count, n);
    assert.deepEqual(g.camps, R.campsForCount(n), 'n=' + n + ' camps');
    assert.equal(g.players.length, n, 'n=' + n + ' 玩家数');
    assert.equal(g.players[n - 1].seat, n - 1);
    g.start();
    assert.equal(g.board.filter((x) => x !== null).length, 10 * n, 'n=' + n + ' 共 ' + 10 * n + ' 子');
    for (let seat = 0; seat < n; seat++) assert.equal(countOf(g.board, seat), 10, 'n=' + n + ' 座位 ' + seat);
    const v = g.view(0);
    assert.equal(v.count, n);
    assert.deepEqual(v.camps, R.campsForCount(n));
    assert.equal(v.goalCount.length, n);
    assert.ok(v.goalCount.every((x) => x === 0));
  }
  // 非法人数回退 2 人
  const g9 = new Game([], 9);
  assert.equal(g9.count, 2);
  assert.deepEqual(g9.camps, [0, 3]);
  assert.deepEqual(g9.players.map((p) => [p.name, p.connected]), [['玩家1', false], ['玩家2', false]]);
  assert.equal(new Game().count, 2, '缺省 2 人');
  assert.equal(new Game([], '3').count, 3, '字符串人数也接受');
});

/* ---------------- 回合轮转 / 各座位走子 ---------------- */

t('回合：0→1→…→n-1→0 轮转，nextSeat 正确', () => {
  for (const n of [2, 3, 6]) {
    const g = newGame(n);
    const order = [];
    for (let i = 0; i < 2 * n; i++) {
      const seat = g.turn;
      const mv = movesOf(g.board, seat)[0];
      assert.ok(mv, 'n=' + n + ' 第 ' + (i + 1) + ' 手轮到座位 ' + seat + ' 必须有棋可走');
      const res = g.move(seat, mv.from, mv.path);
      assert.equal(res.ok, true);
      order.push(seat);
      assert.equal(g.history.length, i + 1);
      assert.deepEqual(g.turn, (seat + 1) % n);
    }
    const expect = [];
    for (let i = 0; i < 2 * n; i++) expect.push(i % n);
    assert.deepEqual(order, expect, 'n=' + n + ' 回合轮转顺序');
    for (let seat = 0; seat < n; seat++) assert.equal(g.nextSeat(seat), (seat + 1) % n);
  }
});

t('3 人局每个座位都能走棋（座位 0 的棋子值是 0 也能走）', () => {
  const g = newGame(3);
  const seats = [];
  for (const seat of [0, 1, 2]) {
    const mv = movesOf(g.board, seat)[0];
    assert.ok(mv, '座位 ' + seat + ' 有棋可走');
    if (seat === 0) assert.equal(g.board[mv.from], 0, '座位 0 的棋子值是 0');
    const res = g.move(seat, mv.from, mv.path);
    assert.equal(res.ok, true);
    seats.push(g.history[g.history.length - 1].seat);
    assert.equal(g.turn, (seat + 1) % 3);
  }
  assert.deepEqual(seats, [0, 1, 2]);
  assert.equal(g.plyCount, 3);
});

/* ---------------- 走一步 / 跳 / 连跳 ---------------- */

t('走一步：history 字段 / lastMove / 轮转 / 盘面', () => {
  const g = newGame(3);
  const mv = movesOf(g.board, 0)[0];
  const res = g.move(0, mv.from, mv.path);
  assert.deepEqual(res, { ok: true, over: false, notation: R.moveNotation(mv.path) });
  assert.equal(g.board[mv.from], null);
  assert.equal(g.board[mv.path[mv.path.length - 1]], 0);
  assert.equal(g.turn, 1);
  assert.deepEqual(g.lastMove, { from: mv.from, path: mv.path });
  assert.deepEqual(g.history[0], {
    ply: 1,
    seat: 0,
    from: mv.from,
    path: mv.path,
    notation: R.moveNotation(mv.path),
    jumps: R.jumpCount(mv.path),
  });
  assert.equal(g.plyCount, 1);
});

t('跳与连跳：记谱 / jumps / 盘面更新（0 号棋子参与）', () => {
  const b = emptyBoard();
  b[centerId] = 0; // 0 号座位
  b[51] = 1;
  const g = setup(b, 0, 3);
  const r1 = g.move(0, centerId, [centerId, 41]);
  assert.deepEqual(r1, { ok: true, over: false, notation: '跳 1 下' });
  assert.equal(g.history[0].jumps, 1);
  assert.equal(g.board[centerId], null);
  assert.equal(g.board[41], 0);
  assert.equal(g.turn, 1);

  const b2 = emptyBoard();
  b2[centerId] = 0;
  b2[51] = 1;
  b2[30] = 2;
  const g2 = setup(b2, 0, 3);
  const r2 = g2.action(0, { type: 'move', from: centerId, path: [centerId, 41, 18] });
  assert.deepEqual(r2, { ok: true, over: false, notation: '跳 2 下' });
  assert.equal(g2.history[0].jumps, 2);
  assert.equal(g2.board[18], 0);
  assert.equal(g2.board[centerId], null);
  assert.deepEqual(g2.view(0).lastMove, { from: centerId, path: [centerId, 41, 18] });
});

t('move 会拷贝 path，调用方改数组不影响历史', () => {
  const g = newGame(2);
  const mv = movesOf(g.board, 0)[0];
  const path = mv.path.slice();
  g.move(0, mv.from, path);
  path.push(999);
  path[1] = 999;
  assert.deepEqual(g.history[0].path, mv.path);
  assert.deepEqual(g.lastMove.path, mv.path);
  assert.deepEqual(g.view(0).moves[0].path, mv.path);
});

/* ---------------- 非法动作 / 观战 ---------------- */

t('非法动作：未开局 / 轮次 / 座位 / 起点 / 路径 / 落点', () => {
  assert.throws(() => new Game(makePlayers(3), 3).move(0, 111, [111, 103]), /对局还没开始或已经结束/);
  const g = newGame(3);
  const mv0 = movesOf(g.board, 0)[0];
  assert.throws(() => g.move(1, movesOf(g.board, 1)[0].from, movesOf(g.board, 1)[0].path), /还没轮到你走棋/, '红先，座位 1 不能先走');
  assert.throws(() => g.move(-1, mv0.from, mv0.path), /观战不能走棋/);
  assert.throws(() => g.move(3, mv0.from, mv0.path), /观战不能走棋/, '没有 3 号座位');
  assert.throws(() => g.move(0, -1, [111, 103]), /走法无效/);
  assert.throws(() => g.move(0, 121, [0, 1]), /走法无效/);
  assert.throws(() => g.move(0, 1.5, [1, 2]), /走法无效/);
  assert.throws(() => g.move(0, NaN, [111, 103]), /走法无效/);
  assert.throws(() => g.move(0, centerId, [centerId, 61]), /这里没有棋子/);
  assert.throws(() => g.move(0, 111, null), /走法无效/);
  assert.throws(() => g.move(0, 111, []), /这步棋走不通/);
  assert.throws(() => g.move(0, 111, [111, 4]), /这步棋走不通/);
  // 越界落点：实现里 board[999] === undefined 也走「落点已经有棋子了」分支（消息略糙，但确实拒绝）
  assert.throws(() => g.move(0, 111, [111, 999]), /落点已经有棋子了/);

  // 那不是你的棋子：座位 0 去走座位 1 的棋子
  const foeId = R.seatHomeIds(1, 3)[0];
  assert.equal(g.board[foeId], 1);
  assert.throws(() => g.move(0, foeId, [foeId, foeId]), /那不是你的棋子/);

  // 落点被占
  const g2 = newGame(2);
  assert.throws(() => g2.move(0, 111, [111, 112]), /落点已经有棋子了/);

  // 结束后不能再走 / 认输
  const over = newGame(3);
  over.resign(1);
  assert.throws(() => over.move(0, movesOf(over.board, 0)[0].from, movesOf(over.board, 0)[0].path), /对局还没开始或已经结束/);
  assert.throws(() => over.resign(0), /对局已经结束/);
});

t('观战限制：座位 <0 或 >= count 不能操作 / 回应请求', () => {
  const g = newGame(3);
  assert.throws(() => g.move(-1, 111, [111, 103]), /观战不能走棋/);
  assert.throws(() => g.resign(3), /观战不能认输/);
  assert.throws(() => g.offerDraw(-1), /观战不能求和/);
  assert.throws(() => g.requestUndo(3), /观战不能悔棋/);
  assert.equal(g.canRequestUndo(-1), false);
  assert.equal(g.canRequestUndo(3), false);

  const mv = movesOf(g.board, 0)[0];
  g.move(0, mv.from, mv.path);
  g.requestUndo(0);
  assert.throws(() => g.replyUndo(-1, true), /观战不能回应悔棋/);
  g.replyUndo(1, false);
  g.offerDraw(0);
  assert.throws(() => g.replyDraw(3, true), /观战不能回应求和/);
  g.replyDraw(1, false);

  const vs = g.view(-1);
  assert.equal(vs.seat, -1);
  assert.equal(vs.spectator, true);
  assert.equal(vs.count, 3);
  assert.deepEqual(vs.camps, R.campsForCount(3));
  assert.equal(vs.canUndo, false);
});

t('有未答复的请求时不能走棋', () => {
  const g = newGame(3);
  const mv = movesOf(g.board, 0)[0];
  g.move(0, mv.from, mv.path);
  g.requestUndo(0);
  assert.throws(() => g.move(1, movesOf(g.board, 1)[0].from, movesOf(g.board, 1)[0].path), /先处理还没答复的悔棋 \/ 求和请求/);
  g.replyUndo(1, false);
  g.offerDraw(0);
  assert.throws(() => g.move(1, movesOf(g.board, 1)[0].from, movesOf(g.board, 1)[0].path), /先处理还没答复的悔棋 \/ 求和请求/);
  g.replyDraw(1, false);
  assert.equal(g.move(1, movesOf(g.board, 1)[0].from, movesOf(g.board, 1)[0].path).ok, true, '拒绝后可以继续');
});

/* ---------------- 入营获胜 ---------------- */

t('座位 0 获胜：winner === 0（不能当成 false）', () => {
  const s = nearWinSetup(0, 2);
  assert.equal(R.inGoal(s.board, 0, 2), 9, '构造局面 9 子已入营');
  const g = setup(s.board, 0, 2);
  const res = g.move(0, s.from, [s.from, s.goalHole]);
  assert.deepEqual(res, { ok: true, over: true, notation: '走 1 步' });
  assert.equal(g.phase, PHASE.OVER);
  assert.equal(g.result.winner, 0, 'winner 必须是数字 0');
  assert.equal(g.result.winner === 0, true);
  assert.ok(g.result.winner >= 0, '0 是有效胜者');
  assert.equal(g.result.reason, 'home');
  assert.equal(g.result.text, 'P0 全部入营，获胜');
  assert.equal(g.result.plies, 1);
  assert.deepEqual(g.view(0).goalCount, [10, 0]);
  assert.equal(g.view(-1).result.winner, 0);
  assert.throws(() => g.move(1, s.goalHole, [s.goalHole, s.from]), /对局还没开始或已经结束/);
  assert.throws(() => g.resign(1), /对局已经结束/);
});

t('2-6 人各座位获胜都返回自己的座位号', () => {
  for (const n of R.PLAYER_COUNTS) {
    for (let seat = 0; seat < n; seat++) {
      const s = nearWinSetup(seat, n);
      // 构造时其他座位都不能已经入营
      for (let k = 0; k < n; k++) {
        if (k !== seat) assert.equal(R.isHome(s.board, k, n), false, 'n=' + n + ' 座位 ' + k + ' 不应提前入营');
      }
      const g = setup(s.board, seat, n);
      const res = g.move(seat, s.from, [s.from, s.goalHole]);
      assert.equal(res.over, true, 'n=' + n + ' 座位 ' + seat + ' 应获胜');
      assert.equal(g.phase, PHASE.OVER);
      assert.equal(g.result.reason, 'home');
      assert.equal(g.result.winner, seat, 'n=' + n + ' 座位 ' + seat + ' 获胜');
      assert.equal(g.result.winner >= 0, true);
      assert.equal(g.result.text, 'P' + seat + ' 全部入营，获胜');
      assert.equal(g.view(0).goalCount[seat], 10);
      assert.equal(R.detectWin(g.board, n), seat);
    }
  }
});

t('只有 9 子入营时不判胜，对局继续', () => {
  const b = emptyBoard();
  const goalIds = R.seatGoalIds(0, 3);
  for (const id of goalIds.slice(0, 9)) b[id] = 0;
  b[centerId] = 0;
  const g = setup(b, 0, 3);
  assert.equal(R.inGoal(g.board, 0, 3), 9);
  const mv = R.legalMoves(b, centerId).find((m) => !goalIds.includes(m.to));
  assert.ok(mv, '中心红子有非入营的走法');
  const res = g.move(0, centerId, mv.path);
  assert.equal(res.over, false);
  assert.equal(g.phase, PHASE.PLAY);
  assert.equal(g.result, null);
  assert.equal(g.view(0).goalCount[0], 9);
  assert.equal(R.detectWin(g.board, 3), -1);
});

/* ---------------- 认输 ---------------- */

t('认输：两人局对方胜；多人局 winner=-1 本局结束', () => {
  // 两人局
  const g2 = newGame(2);
  const mv2 = movesOf(g2.board, 0)[0];
  g2.move(0, mv2.from, mv2.path);
  assert.deepEqual(g2.resign(0), { ok: true, over: true });
  assert.equal(g2.phase, PHASE.OVER);
  assert.equal(g2.result.winner, 1);
  assert.equal(g2.result.winner >= 0, true);
  assert.equal(g2.result.reason, 'resign');
  assert.equal(g2.result.text, 'P1 胜（对方认输）');
  assert.equal(g2.result.plies, 1);
  assert.equal(g2.result.resigned, undefined, '两人局没有 resigned 字段值');

  // 多人局：直接结束，无胜者
  for (const n of [3, 4, 6]) {
    const g = newGame(n);
    const res = g.resign(n - 1);
    assert.deepEqual(res, { ok: true, over: true });
    assert.equal(g.phase, PHASE.OVER);
    assert.equal(g.result.winner, -1, 'n=' + n + ' 多人认输 winner=-1');
    assert.equal(g.result.winner >= 0, false);
    assert.equal(g.result.reason, 'resign');
    assert.equal(g.result.text, 'P' + (n - 1) + ' 认输，本局结束');
    assert.equal(g.result.resigned, n - 1);
    assert.deepEqual(g.view(0).offers, { undo: null, draw: null }, '认输后清空请求');
  }
  assert.throws(() => new Game(makePlayers(3), 3).resign(0), /对局已经结束/, '大厅里不能认输');
});

/* ---------------- 求和 ---------------- */

t('求和：需要所有其他玩家同意，拒绝即取消', () => {
  const g = newGame(3);
  assert.deepEqual(g.offerDraw(1), { ok: true });
  assert.deepEqual(g.view(0).offers.draw, { by: 1, accepts: [] });
  assert.throws(() => g.replyDraw(1, true), /不能自己答应自己/);
  // 第 1 个同意，还差 1 个
  assert.deepEqual(g.replyDraw(0, true), { ok: true, over: false, accepted: true, waiting: 1 });
  assert.deepEqual(g.view(2).offers.draw, { by: 1, accepts: [0] });
  // 重复同意不会重复计数
  assert.deepEqual(g.replyDraw(0, true), { ok: true, over: false, accepted: true, waiting: 1 });
  assert.deepEqual(g.view(2).offers.draw.accepts, [0]);
  // 最后一个同意 → 和棋
  const done = g.replyDraw(2, true);
  assert.deepEqual(done, { ok: true, over: true, accepted: true });
  assert.equal(g.phase, PHASE.OVER);
  assert.equal(g.result.winner, -1, '和棋 winner=-1');
  assert.equal(g.result.winner >= 0, false);
  assert.equal(g.result.reason, 'draw');
  assert.equal(g.result.text, '和棋（全部玩家同意）');
  assert.throws(() => g.replyDraw(0, true), /没有待回应的求和请求/);

  // 6 人局：5 个其他玩家都同意才和棋；中途一人拒绝就取消
  const g6 = newGame(6);
  g6.offerDraw(3);
  assert.deepEqual(g6.replyDraw(0, true).waiting, 4);
  assert.deepEqual(g6.replyDraw(1, true).waiting, 3);
  assert.deepEqual(g6.replyDraw(2, true).waiting, 2);
  assert.deepEqual(g6.replyDraw(4, true).waiting, 1);
  assert.deepEqual(g6.view(0).offers.draw, { by: 3, accepts: [0, 1, 2, 4] });
  const g6done = g6.replyDraw(5, true);
  assert.equal(g6done.over, true);
  assert.equal(g6.result.winner, -1);

  const g6b = newGame(6);
  g6b.offerDraw(0);
  g6b.replyDraw(1, true);
  const rejected = g6b.replyDraw(2, false);
  assert.deepEqual(rejected, { ok: true, over: false, accepted: false, rejected: true });
  assert.deepEqual(g6b.view(0).offers, { undo: null, draw: null });
  assert.equal(g6b.phase, PHASE.PLAY, '拒绝求和后对局继续');

  // 限制
  assert.throws(() => g6b.replyDraw(1, true), /没有待回应的求和请求/);
  assert.throws(() => g6b.offerDraw(-1), /观战不能求和/);
  const over = newGame(3);
  over.resign(0);
  assert.throws(() => over.offerDraw(1), /对局已经结束/);
});

/* ---------------- 悔棋（多人） ---------------- */

t('悔棋：回退到「请求方上一步之前」，多人一起退回', () => {
  // 3 人：走满一轮后座位 0 悔棋 → 退 3 手
  const g = newGame(3);
  for (let i = 0; i < 3; i++) {
    const seat = g.turn;
    const mv = movesOf(g.board, seat)[0];
    g.move(seat, mv.from, mv.path);
  }
  assert.equal(g.turn, 0);
  assert.deepEqual(g.history.map((h) => h.seat), [0, 1, 2]);
  g.requestUndo(0);
  const r = g.replyUndo(1, true);
  assert.deepEqual(r, { ok: true, over: false, accepted: true, popped: 3 });
  assert.equal(g.history.length, 0);
  assert.equal(g.turn, 0);
  assert.equal(g.board.join(','), R.initialBoard(3).join(','));
  assert.equal(g.lastMove, null);

  // 6 人：走满一轮后座位 0 悔棋 → 退 6 手
  const g6 = newGame(6);
  for (let i = 0; i < 6; i++) {
    const seat = g6.turn;
    const mv = movesOf(g6.board, seat)[0];
    g6.move(seat, mv.from, mv.path);
  }
  assert.equal(g6.turn, 0);
  g6.requestUndo(0);
  const r6 = g6.replyUndo(2, true);
  assert.equal(r6.popped, 6);
  assert.equal(g6.history.length, 0);
  assert.deepEqual(g6.board, R.initialBoard(6));

  // 4 人：0,1,2,3,0 之后座位 1 悔棋 → 退到座位 1 上一步之前（退 4 手）
  const g4 = newGame(4);
  for (let i = 0; i < 5; i++) {
    const seat = g4.turn;
    const mv = movesOf(g4.board, seat)[0];
    g4.move(seat, mv.from, mv.path);
  }
  assert.deepEqual(g4.history.map((h) => h.seat), [0, 1, 2, 3, 0]);
  assert.equal(g4.turn, 1);
  const boardBefore = g4.board.join(',');
  g4.requestUndo(1);
  const r4 = g4.replyUndo(2, true);
  assert.equal(r4.popped, 4);
  assert.deepEqual(g4.history.map((h) => h.seat), [0]);
  assert.equal(g4.turn, 1);
  assert.equal(g4.history.length, 1);
  assert.equal(g4.view(0).moves[0].seat, 0);
  assert.ok(g4.board.join(',') !== boardBefore);

  // 2 人：刚走完还没应招只退 1 手
  const g2 = newGame(2);
  const mv2 = movesOf(g2.board, 0)[0];
  g2.move(0, mv2.from, mv2.path);
  g2.requestUndo(0);
  assert.equal(g2.replyUndo(1, true).popped, 1);
  assert.equal(g2.history.length, 0);
});

t('悔棋：拒绝则局面不变；未走棋/重复请求/无请求限制', () => {
  const g = newGame(3);
  assert.equal(g.view(1).canUndo, false);
  assert.throws(() => g.requestUndo(0), /你还没走过棋，没有可悔的/);
  const mv = movesOf(g.board, 0)[0];
  g.move(0, mv.from, mv.path);
  assert.equal(g.view(1).canUndo, false, '座位 1 还没走过棋');
  assert.throws(() => g.requestUndo(1), /你还没走过棋，没有可悔的/);
  assert.throws(() => g.replyUndo(1, true), /没有待回应的悔棋请求/);
  g.requestUndo(0);
  assert.equal(g.view(0).canUndo, false, '请求挂起时不能悔棋');
  assert.throws(() => g.requestUndo(0), /已经有一个悔棋请求在等回应/);
  assert.throws(() => g.replyUndo(0, true), /不能自己答应自己/);

  const board = g.board.join(',');
  const hist = JSON.stringify(g.history);
  const r = g.replyUndo(1, false);
  assert.deepEqual(r, { ok: true, over: false, accepted: false });
  assert.equal(g.board.join(','), board);
  assert.equal(JSON.stringify(g.history), hist);
  assert.equal(g.phase, PHASE.PLAY);
  assert.deepEqual(g.view(0).offers, { undo: null, draw: null });

  // 与求和互斥
  g.requestUndo(0);
  assert.throws(() => g.offerDraw(1), /先处理悔棋请求/);
  g.replyUndo(1, false);
  g.offerDraw(1);
  assert.throws(() => g.requestUndo(0), /先处理求和请求/);
  g.replyDraw(0, false);

  const over = newGame(3);
  over.resign(0);
  assert.throws(() => over.requestUndo(1), /对局已经结束/);
  assert.equal(over.canRequestUndo(1), false);
});

/* ---------------- view ---------------- */

t('view：契约字段完整（count/camps/goalCount 数组/offers/winner）', () => {
  const g = newGame(3);
  const mv = movesOf(g.board, 0)[0];
  g.move(0, mv.from, mv.path);
  const v0 = g.view(0);
  const v1 = g.view(1);
  const vs = g.view(-1);
  const keys = ['phase', 'round', 'count', 'camps', 'seat', 'spectator', 'turn', 'board', 'players', 'moves', 'lastMove', 'goalCount', 'offers', 'canUndo', 'result', 'startedAt'];
  assert.deepEqual(Object.keys(v0).sort(), keys.slice().sort());

  assert.equal(v0.phase, 'play');
  assert.equal(v0.round, 1);
  assert.equal(v0.count, 3);
  assert.deepEqual(v0.camps, R.campsForCount(3));
  assert.equal(v0.seat, 0);
  assert.equal(v0.spectator, false);
  assert.equal(v1.seat, 1);
  assert.equal(vs.seat, -1);
  assert.equal(vs.spectator, true);
  assert.equal(v0.turn, 1);
  assert.equal(v0.board.length, 121);
  assert.equal(v0.players.length, 3);
  for (const p of v0.players) assert.deepEqual(Object.keys(p).sort(), ['connected', 'name', 'seat']);
  assert.deepEqual(v0.players.map((p) => p.seat), [0, 1, 2]);
  assert.equal(v0.moves.length, 1);
  assert.deepEqual(v0.moves[0], {
    ply: 1,
    seat: 0,
    from: mv.from,
    path: mv.path,
    notation: R.moveNotation(mv.path),
    jumps: R.jumpCount(mv.path),
  });
  assert.deepEqual(v0.lastMove, { from: mv.from, path: mv.path });
  assert.deepEqual(v0.goalCount, [0, 0, 0]);
  assert.equal(v0.goalCount.length, 3);
  for (let s = 0; s < 3; s++) assert.equal(v0.goalCount[s], R.inGoal(g.board, s, 3));
  assert.deepEqual(v0.offers, { undo: null, draw: null });
  assert.equal(v0.canUndo, true, '座位 0 走过棋');
  assert.equal(v1.canUndo, false);
  assert.equal(vs.canUndo, false);
  assert.equal(v0.result, null);
  assert.ok(v0.startedAt > 0);
});

t('view：副本与内部状态隔离', () => {
  const g = newGame(3);
  const mv = movesOf(g.board, 0)[0];
  g.move(0, mv.from, mv.path);
  const v = g.view(0);
  v.board[0] = 9;
  v.moves[0].path.push(999);
  v.players[0].name = '改过';
  v.players.push({});
  v.lastMove.path.push(999);
  v.offers.undo = 0;
  v.goalCount.push(99);
  assert.equal(g.board[0], null);
  assert.equal(g.history[0].path.length, mv.path.length);
  assert.equal(g.players.length, 3);
  assert.equal(g.players[0].name, 'P0');
  assert.equal(g.lastMove.path.length, mv.path.length);
  assert.deepEqual(g.offers, { undo: null, draw: null });
  assert.equal(g.view(0).goalCount.length, 3);

  // offers.draw 里的 accepts 也是副本
  g.offerDraw(1);
  const vd = g.view(0);
  vd.offers.draw.accepts.push(9);
  assert.deepEqual(g.offers.draw, { by: 1, accepts: [] });
  assert.deepEqual(g.view(0).offers.draw, { by: 1, accepts: [] });
});

t('view：winner=-1（和棋/多人认输）与 offers.draw 结构', () => {
  // 和棋
  const g = newGame(3);
  g.offerDraw(1);
  assert.deepEqual(g.view(0).offers.draw, { by: 1, accepts: [] });
  g.replyDraw(0, true);
  assert.deepEqual(g.view(2).offers.draw, { by: 1, accepts: [0] });
  g.replyDraw(2, true);
  const vr = g.view(0).result;
  assert.equal(vr.winner, -1);
  assert.equal(vr.winner >= 0, false);
  assert.equal(vr.reason, 'draw');
  assert.equal(vr.text, '和棋（全部玩家同意）');
  assert.equal(vr.plies, 0);
  assert.deepEqual(g.view(-1).offers, { undo: null, draw: null });

  // 多人认输
  const g2 = newGame(4);
  g2.resign(2);
  const r2 = g2.view(0).result;
  assert.equal(r2.winner, -1);
  assert.equal(r2.reason, 'resign');
  assert.equal(r2.resigned, 2);
  assert.equal(r2.text, 'P2 认输，本局结束');
});

/* ---------------- 其他 ---------------- */

t('action 统一入口：分发 / 字符串转换 / 无效操作', () => {
  const g = newGame(3);
  assert.throws(() => g.action(0, null), /无效操作/);
  assert.throws(() => g.action(0, undefined), /无效操作/);
  assert.throws(() => g.action(0, 'move'), /无效操作/);
  assert.throws(() => g.action(0, {}), /无效操作/);
  assert.throws(() => g.action(0, { type: 'bogus' }), /无效操作/);

  const mv = movesOf(g.board, 0)[0];
  const res = g.action(0, { type: 'move', from: String(mv.from), path: mv.path.map(String) });
  assert.equal(res.ok, true);
  assert.deepEqual(g.lastMove, { from: mv.from, path: mv.path });
  assert.throws(() => g.action(1, { type: 'move', from: 'abc', path: [1, 2] }), /走法无效/);

  // 座位 1 再走一步，才能请求悔棋
  const mv1 = movesOf(g.board, 1)[0];
  assert.equal(g.action(1, { type: 'move', from: mv1.from, path: mv1.path }).ok, true);
  assert.equal(g.turn, 2);

  g.action(0, { type: 'draw' });
  assert.equal(g.view(1).offers.draw.by, 0);
  assert.deepEqual(g.action(1, { type: 'drawReply', accept: false }), { ok: true, over: false, accepted: false, rejected: true });
  assert.equal(g.action(1, { type: 'undo' }).ok, true, '座位 1 已走过棋，可以请求悔棋');
  assert.equal(g.view(0).offers.undo, 1);
  const r = g.action(0, { type: 'undoReply', accept: true });
  assert.equal(r.accepted, true);
  assert.equal(g.history.length, 1, '座位 1 刚走完只退 1 手');
  assert.equal(g.turn, 1);
  g.action(2, { type: 'resign' });
  assert.equal(g.result.winner, -1);
  assert.equal(g.result.resigned, 2);
});

t('再开一局：清空状态 / 递增 round / 保留 count 与 camps', () => {
  const g = newGame(6);
  const mv = movesOf(g.board, 0)[0];
  g.move(0, mv.from, mv.path);
  g.resign(3);
  assert.equal(g.phase, PHASE.OVER);
  const at = g.startedAt;
  g.start();
  assert.equal(g.phase, PHASE.PLAY);
  assert.equal(g.round, 2);
  assert.equal(g.count, 6);
  assert.deepEqual(g.camps, R.campsForCount(6));
  assert.equal(g.turn, 0);
  assert.equal(g.plyCount, 0);
  assert.equal(g.result, null);
  assert.equal(g.lastMove, null);
  assert.deepEqual(g.offers, { undo: null, draw: null });
  assert.equal(g.board.filter((x) => x !== null).length, 60);
  assert.ok(g.startedAt >= at);
});

/* ---------------- 随机对局不变量 ---------------- */

t('随机对局不变量：2/3/6 人各 100-200 手', () => {
  const configs = [[2, 200], [3, 150], [6, 150], [4, 120], [5, 120]];
  let sawJump = false;
  let sawMultiJump = false;
  for (const [n, limit] of configs) {
    for (const seed of [1, 7]) {
      const rand = rng(seed * 1000 + n);
      const g = newGame(n);
      let ended = false;
      for (let ply = 0; ply < limit; ply++) {
        const seat = g.turn;
        const boardBefore = g.board.slice();
        // 每人始终 10 子，棋子值 = 座位号
        for (let s = 0; s < n; s++) assert.equal(countOf(boardBefore, s), 10, 'n=' + n + ' seed ' + seed + ' 第 ' + (ply + 1) + ' 手座位 ' + s + ' 棋子数');
        // 轮到谁谁的棋子就是 seat
        const ms = movesOf(boardBefore, seat);
        assert.ok(ms.length > 0, 'n=' + n + ' seed ' + seed + ' 第 ' + (ply + 1) + ' 手无棋可走');
        const pick = ms[Math.floor(rand() * ms.length)];
        assert.ok(R.isLegalMove(boardBefore, pick.from, pick.path), '选中的走法合法');

        const res = g.action(seat, { type: 'move', from: pick.from, path: pick.path });
        assert.equal(res.ok, true);
        assert.equal(res.notation, R.moveNotation(pick.path), '记谱与规则一致');
        assert.equal(res.over, g.phase === PHASE.OVER);

        // 盘面按 applyMove 变化；棋子数不变
        const applied = R.applyMove(boardBefore, pick.from, pick.path);
        assert.equal(g.board.join(','), applied.board.join(','), '盘面与 applyMove 一致');
        for (let s = 0; s < n; s++) assert.equal(countOf(g.board, s), 10, '走完后每座位仍 10 子');
        assert.equal(g.turn, (seat + 1) % n, '回合轮转');

        // history
        assert.equal(g.history.length, ply + 1);
        const h = g.history[g.history.length - 1];
        assert.equal(h.ply, ply + 1);
        assert.equal(h.seat, seat);
        assert.equal(h.from, pick.from);
        assert.deepEqual(h.path, pick.path);
        assert.equal(h.notation, res.notation);
        assert.equal(h.jumps, R.jumpCount(pick.path));
        if (h.jumps > 1) sawMultiJump = true;
        else if (h.jumps > 0) sawJump = true;

        // view 与内部一致
        const v = g.view(0);
        assert.equal(v.count, n);
        assert.deepEqual(v.camps, R.campsForCount(n));
        assert.equal(v.goalCount.length, n);
        for (let s = 0; s < n; s++) assert.equal(v.goalCount[s], R.inGoal(g.board, s, n), 'goalCount 与 rules 一致');
        assert.deepEqual(v.lastMove, { from: pick.from, path: pick.path });
        assert.equal(v.moves.length, g.history.length);

        if (g.phase === PHASE.PLAY) {
          assert.equal(g.result, null);
          assert.equal(R.detectWin(g.board, n), -1);
          assert.equal(R.hasAnyMove(g.board, g.turn), true, '轮到的一方必须有棋可走');
        } else {
          const winner = R.detectWin(g.board, n);
          assert.ok(winner >= 0, '入营结束必须有胜者');
          assert.equal(g.result.winner, winner);
          assert.equal(g.result.reason, 'home');
          assert.equal(v.goalCount[winner], 10);
          assert.equal(g.result.plies, g.history.length);
          ended = true;
          break;
        }
      }
      if (!ended) {
        assert.equal(g.history.length, limit, 'n=' + n + ' seed ' + seed + ' 应走满 ' + limit + ' 手');
        assert.equal(g.phase, PHASE.PLAY);
        assert.equal(g.turn, 0, 'limit 是 n 的倍数，应回到座位 0');
        assert.equal(g.board.filter((x) => x !== null).length, 10 * n);
      }
    }
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
