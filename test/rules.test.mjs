// 中国跳棋规则引擎单元测试（2-6 人，零依赖，纯 node）：node test/rules.test.mjs
// 重点：座位号就是棋子编码（0 是有效棋子）、六营、目标营=对面营、2-6 人开局与胜负
// 风格对齐五子棋 test/：problems 收集 + ✅/❌ + process.exit(1)
import assert from 'node:assert/strict';
import * as R from '../js/rules.js';

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
const SQRT3 = Math.sqrt(3);
const idsOf = (ids) => JSON.stringify(ids);

/* ---------------- 常量 / 棋盘 ---------------- */

t('常量：座位颜色名、可选人数、尺寸', () => {
  assert.equal(R.SIZE, 121);
  assert.deepEqual(R.SEAT_NAMES, ['红', '蓝', '绿', '橙', '紫', '青']);
  assert.deepEqual(R.PLAYER_COUNTS, [2, 3, 4, 5, 6]);
  assert.equal(R.HOLES.length, 121);
  assert.equal(R.CAMPS.length, 6);
  assert.deepEqual(R.CAMP_KEYS, ['z+', 'x-', 'y+', 'z-', 'x+', 'y-']);
});

t('棋盘规格：121 孔、立方坐标、holeAt 互逆', () => {
  assert.ok(R.HOLES.every((h, i) => h.id === i), 'id 与下标一致');
  assert.ok(R.HOLES.every((h) => h.x + h.y + h.z === 0), 'x+y+z=0');
  const keys = new Set(R.HOLES.map((h) => h.q + ',' + h.r));
  assert.equal(keys.size, 121, '(q,r) 不重复');
  for (const h of R.HOLES) assert.equal(R.holeAt(h.q, h.r), h.id, 'holeAt 互逆 ' + coord(h.id));
  assert.equal(R.holeAt(99, 0), -1);
  assert.equal(R.holeAt(0, 99), -1);
  assert.equal(R.holeAt(5, 5), -1);

  const inCenter = R.HOLES.filter((h) => Math.max(Math.abs(h.x), Math.abs(h.y), Math.abs(h.z)) <= 4);
  const tips = R.HOLES.filter((h) => {
    const v = [h.x, h.y, h.z];
    const tip = v.filter((n) => Math.abs(n) >= 5 && Math.abs(n) <= 8).length;
    const inner = v.filter((n) => Math.abs(n) <= 4).length;
    return tip === 1 && inner === 2;
  });
  assert.equal(inCenter.length, 61, '中心六边形 61 孔');
  assert.equal(tips.length, 60, '六个尖角共 60 孔');
  assert.equal(inCenter.length + tips.length, R.SIZE);
  assert.equal(centerId, 60);
  assert.equal(R.HOLES[centerId].q, 0);
  assert.equal(R.HOLES[centerId].r, 0);
});

t('像素坐标与 VIEW 合理', () => {
  for (const h of R.HOLES) {
    assert.ok(Math.abs(h.px - SQRT3 * (h.q + h.r / 2)) < 1e-12, 'px 公式 ' + coord(h.id));
    assert.ok(Math.abs(h.py - 1.5 * h.r) < 1e-12, 'py 公式 ' + coord(h.id));
  }
  const V = R.VIEW;
  assert.ok([V.x, V.y, V.w, V.h].every((n) => typeof n === 'number' && Number.isFinite(n)));
  assert.ok(V.w > 0 && V.h > 0);
  for (const h of R.HOLES) {
    assert.ok(h.px >= V.x && h.px <= V.x + V.w, '像素 x 在 viewBox 内 ' + coord(h.id));
    assert.ok(h.py >= V.y && h.py <= V.y + V.h, '像素 y 在 viewBox 内 ' + coord(h.id));
  }
  assert.equal(R.BOARD_TRIANGLES.length, 2);
});

t('DIRS：6 个方向、向量相反成对', () => {
  assert.equal(R.DIRS.length, 6);
  const set = new Set(R.DIRS.map(([q, r]) => q + ',' + r));
  assert.equal(set.size, 6);
  for (const [q, r] of R.DIRS) assert.ok(set.has(-q + ',' + -r), '反方向存在：' + q + ',' + r);
});

/* ---------------- 六个营 ---------------- */

t('六营数据：各 10 孔、目标营=对面营、三角形/中心可用', () => {
  const seen = new Set();
  for (let i = 0; i < R.CAMPS.length; i++) {
    const c = R.CAMPS[i];
    assert.equal(c.index, i);
    assert.equal(c.key, R.CAMP_KEYS[i]);
    assert.equal(c.ids.length, 10, '营 ' + i + ' 有 10 孔');
    assert.equal(new Set(c.ids).size, 10, '营 ' + i + ' 孔不重复');
    assert.equal(c.goal, (i + 3) % 6, '营 ' + i + ' 的目标是对面营');
    assert.equal(c.tri.length, 3, '营 ' + i + ' 三角形 3 个点');
    for (const [x, y] of c.tri) assert.ok(Number.isFinite(x) && Number.isFinite(y));
    assert.ok(Number.isFinite(c.center.px) && Number.isFinite(c.center.py), '营中心坐标有限');
    for (const id of c.ids) {
      assert.ok(!seen.has(id), '营孔 ' + id + ' 只能属于一个营');
      seen.add(id);
    }
  }
  assert.equal(seen.size, 60, '六个营共 60 个孔');
  // 对面营的几何中心关于星形中心对称
  for (let i = 0; i < 3; i++) {
    const a = R.CAMPS[i].center;
    const b = R.CAMPS[i + 3].center;
    assert.ok(Math.abs(a.px + b.px) < 1e-9 && Math.abs(a.py + b.py) < 1e-9, '营 ' + i + ' / ' + (i + 3) + ' 中心对称');
  }
});

t('campsForCount：2-6 人各配置正确、非法人数回退 2', () => {
  assert.deepEqual(R.campsForCount(2), [0, 3]);
  assert.deepEqual(R.campsForCount(3), [0, 2, 4]);
  assert.deepEqual(R.campsForCount(4), [1, 2, 4, 5]);
  assert.deepEqual(R.campsForCount(5), [0, 1, 2, 3, 4]);
  assert.deepEqual(R.campsForCount(6), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(R.campsForCount('3'), [0, 2, 4], '字符串人数也接受');
  assert.deepEqual(R.campsForCount(7), [0, 3], '非法人数回退 2 人');
  assert.deepEqual(R.campsForCount(1), [0, 3]);
  // 返回副本，改它不影响下一次
  const a = R.campsForCount(2);
  a.push(5);
  assert.deepEqual(R.campsForCount(2), [0, 3]);
});

t('seatCamp / seatGoalCamp / seatHomeIds / seatGoalIds', () => {
  for (const n of R.PLAYER_COUNTS) {
    const camps = R.campsForCount(n);
    assert.equal(new Set(camps).size, n, 'n=' + n + ' 的营互不重复');
    for (let seat = 0; seat < n; seat++) {
      const camp = R.seatCamp(seat, n);
      assert.equal(camp, camps[seat], 'n=' + n + ' 座位 ' + seat + ' 的营 = campsForCount[seat]');
      assert.equal(R.seatGoalCamp(seat, n), (camp + 3) % 6, '目标营 = 出发营对面');
      assert.equal(idsOf(R.seatHomeIds(seat, n)), idsOf(R.CAMPS[camp].ids), '出发营孔一致');
      assert.equal(idsOf(R.seatGoalIds(seat, n)), idsOf(R.CAMPS[(camp + 3) % 6].ids), '目标营孔一致');
      const home = R.seatHomeIds(seat, n);
      const goal = R.seatGoalIds(seat, n);
      assert.ok(home.every((id) => !goal.includes(id)), '出发营与目标营不重叠');
    }
  }
});

/* ---------------- 2-6 人初始棋盘 ---------------- */

t('initialBoard：2-6 人各 10n 子、棋子值=座位号、0 号座位有效', () => {
  for (const n of R.PLAYER_COUNTS) {
    const b = R.initialBoard(n);
    assert.equal(b.length, 121);
    assert.equal(b.filter((x) => x !== null).length, 10 * n, 'n=' + n + ' 共 ' + 10 * n + ' 子');
    for (let seat = 0; seat < n; seat++) {
      const own = b.filter((x) => x === seat).length;
      assert.equal(own, 10, 'n=' + n + ' 座位 ' + seat + ' 有 10 子');
      for (const id of R.seatHomeIds(seat, n)) assert.equal(b[id], seat, '座位 ' + seat + ' 的出发营 ' + coord(id));
      for (const id of R.seatGoalIds(seat, n)) assert.equal(b[id] === seat, false, '开局时目标营还没有自己的子');
    }
    assert.ok(b.includes(0), 'n=' + n + ' 棋盘上有 0 号座位的棋子（0 是有效棋子）');
    assert.ok(b.every((x) => x === null || (Number.isInteger(x) && x >= 0 && x < n)), '棋子值合法');
    assert.equal(R.detectWin(b, n), -1, 'n=' + n + ' 开局无人获胜');
    for (let seat = 0; seat < n; seat++) assert.equal(R.inGoal(b, seat, n), 0);
  }
});

t('initialBoard：缺省/非法人数回退 2 人', () => {
  const def = R.initialBoard();
  assert.equal(def.filter((x) => x !== null).length, 20);
  assert.deepEqual(R.initialBoard(7), R.initialBoard(2));
  assert.deepEqual(R.initialBoard('3'), R.initialBoard(3));
});

t('0 号座位的棋子是有效棋子（判空必须用 === null）', () => {
  const b = emptyBoard();
  b[centerId] = 0;
  const reach = R.reachable(b, centerId);
  assert.equal(reach.size, 6, '中心孔有 6 个相邻落点，0 号棋子不能被当成空格');
  for (const [, path] of reach) assert.equal(path.length, 2, '都是走一步');
  // 相邻一步（61 是 60 的相邻孔）
  assert.equal(R.isLegalMove(b, centerId, [centerId, 61]), true);
  const ap = R.applyMove(b, centerId, [centerId, 61]);
  assert.equal(ap.seat, 0, 'applyMove 返回的 seat 是 0');
  assert.equal(ap.board[61], 0, '落点棋子值是 0');
  assert.equal(ap.board[centerId], null);
  assert.equal(b[centerId], 0, '原棋盘不变');
  assert.equal(R.hasAnyMove(b, 0), true, '0 号座位有棋可走');
  assert.equal(R.hasAnyMove(b, 1), false);
});

/* ---------------- 走一步 / 跳 / 连跳 ---------------- */

t('走一步：路径 [from,to]，原棋盘不变（2 人座位 0）', () => {
  const b = R.initialBoard(2);
  const snapshot = b.join(',');
  const from = 111;
  const to = 103;
  assert.equal(b[from], 0, '111 号是 0 号座位');
  assert.ok(R.isLegalMove(b, from, [from, to]));
  assert.ok(R.isStep([from, to]));
  assert.equal(R.jumpCount([from, to]), 0);
  assert.equal(R.moveNotation([from, to]), '走 1 步');
  assert.deepEqual(R.reachable(b, from).get(to), [from, to]);
  assert.ok(R.legalMoves(b, from).some((m) => m.to === to));
  const { board, seat, to: dest } = R.applyMove(b, from, [from, to]);
  assert.equal(seat, 0);
  assert.equal(dest, to);
  assert.equal(board[from], null);
  assert.equal(board[to], 0);
  assert.equal(b.join(','), snapshot, 'applyMove 不修改原棋盘');
});

t('跳：隔一个棋子跳两格，路径只记录落点（棋子值可为 0）', () => {
  const b = emptyBoard();
  b[centerId] = 0; // 0 号座位的棋子
  b[51] = 1; // 60→41 中间是 1 号座位的子
  const path = [centerId, 41];
  assert.ok(R.isLegalMove(b, centerId, path));
  assert.equal(R.jumpCount(path), 1);
  assert.equal(R.moveNotation(path), '跳 1 下');
  const reach = R.reachable(b, centerId);
  assert.ok(reach instanceof Map);
  assert.deepEqual(reach.get(41), path, '路径只记录落点，不含被跳过的孔');
  assert.equal(reach.has(51), false, '被占的孔不是落点');
  // 跳过的可以是任意座位的棋子，包括自己的
  const own = emptyBoard();
  own[centerId] = 0;
  own[51] = 0;
  assert.ok(R.isLegalMove(own, centerId, path), '可以跳过自己的棋子');
});

t('连跳：一次跳多下，落点序列构成路径', () => {
  const b = emptyBoard();
  b[centerId] = 0;
  b[51] = 1;
  b[30] = 2;
  const path = [centerId, 41, 18];
  assert.ok(R.isLegalMove(b, centerId, path));
  assert.equal(R.jumpCount(path), 2);
  assert.equal(R.moveNotation(path), '跳 2 下');
  assert.ok(!R.isStep([path[0], path[1]]));
  assert.deepEqual(R.reachable(b, centerId).get(18), path);
  const { board, seat, to } = R.applyMove(b, centerId, path);
  assert.equal(seat, 0);
  assert.equal(to, 18);
  assert.equal(board[centerId], null);
  assert.equal(board[18], 0);
});

t('不能落子到有子的孔', () => {
  const b = emptyBoard();
  b[centerId] = 0;
  b[51] = 1;
  assert.equal(R.isLegalMove(b, centerId, [centerId, 51]), false, '走一步撞子');
  assert.equal(R.isLegalMove(b, centerId, [centerId, 41]), true, '隔子跳可以');
  const reach = R.reachable(b, centerId);
  for (const [, path] of reach) assert.equal(b[path[path.length - 1]], null, '所有可达落点都是空格');
  assert.equal(R.legalMoves(b, centerId).some((m) => m.to === 51), false);
});

t('伪装路径一律拒绝', () => {
  const b = emptyBoard();
  b[centerId] = 0;
  b[51] = 1;
  const bad = (desc, board, from, path) => assert.equal(R.isLegalMove(board, from, path), false, desc);

  bad('path 起点不是 from', b, centerId, [51, 41]);
  bad('长度不足', b, centerId, [centerId]);
  bad('空路径', b, centerId, []);
  bad('路径不是数组', b, centerId, null);
  bad('起点没有棋子', b, 61, [61, centerId]);
  bad('起点越界', b, -1, [-1, 60]);
  bad('落点越界', b, centerId, [centerId, 999]);
  bad('落到有子的孔', b, centerId, [centerId, 51]);
  bad('重复经过同一孔', b, centerId, [centerId, 41, centerId]);

  const emptyMid = emptyBoard();
  emptyMid[centerId] = 0;
  bad('中间没有棋子却跳两格', emptyMid, centerId, [centerId, 41]);

  const mix = emptyBoard();
  mix[centerId] = 0;
  mix[41] = 1; // 51→30 的中间子
  bad('走一步 + 跳混合', mix, centerId, [centerId, 51, 30]);

  bad('跳三格（不是跳两格）', b, centerId, [centerId, 30]);
  bad('不对齐的双倍位移', b, centerId, [centerId, R.holeAt(2, 2)]);
  bad('奇数位移', b, centerId, [centerId, R.holeAt(1, -2)]);

  const occupiedMidLanding = emptyBoard();
  occupiedMidLanding[centerId] = 0;
  occupiedMidLanding[41] = 1;
  bad('连跳中途落点有子', occupiedMidLanding, centerId, [centerId, 41, 18]);
});

t('reachable / legalMoves 返回的每一步都合法', () => {
  const b = emptyBoard();
  b[centerId] = 0;
  b[51] = 1;
  const reach = R.reachable(b, centerId);
  assert.ok(reach instanceof Map);
  assert.equal(reach.size, 6, '5 个走一步 + 1 个跳');
  for (const [to, path] of reach) {
    assert.equal(path[0], centerId);
    assert.equal(path[path.length - 1], to);
    assert.ok(R.isLegalMove(b, centerId, path), '可达路径应合法：' + JSON.stringify(path));
    assert.equal(b[to], null);
  }
  const moves = R.legalMoves(b, centerId);
  assert.ok(Array.isArray(moves));
  assert.equal(moves.length, reach.size);
  for (const m of moves) {
    assert.equal(m.to, m.path[m.path.length - 1]);
    assert.ok(R.isLegalMove(b, centerId, m.path));
  }
  assert.equal(R.reachable(b, 61).size, 0);
  assert.equal(R.reachable(b, -1).size, 0);
  assert.equal(R.legalMoves(b, 121).length, 0);
});

t('走子描述：走 1 步 / 跳 n 下', () => {
  assert.equal(R.moveNotation([111, 103]), '走 1 步');
  assert.equal(R.moveNotation([centerId, 41]), '跳 1 下');
  assert.equal(R.moveNotation([centerId, 41, 18]), '跳 2 下');
  assert.equal(R.jumpCount([0, 1, 2, 3, 4, 5]), 5);
  assert.equal(R.moveNotation([0, 1, 2, 3, 4, 5]), '跳 5 下');
  assert.equal(R.jumpCount([111, 103]), 0);
  assert.equal(R.jumpCount([111]), 0);
  assert.equal(R.jumpCount(null), 0);
  assert.equal(R.isStep([111, 103]), true);
  assert.equal(R.isStep([centerId, 41]), false);
  assert.equal(R.isStep([centerId, 41, 18]), false);
  assert.equal(R.isStep([111]), false);
  assert.equal(R.isStep(null), false);
});

/* ---------------- 入营 / 胜负 ---------------- */

t('inGoal / isHome：按座位数目标营里的自己的子', () => {
  for (const n of [2, 3, 6]) {
    for (let seat = 0; seat < n; seat++) {
      const b = emptyBoard();
      const goalIds = R.seatGoalIds(seat, n);
      assert.equal(R.inGoal(b, seat, n), 0);
      for (const id of goalIds.slice(0, 9)) b[id] = seat;
      assert.equal(R.inGoal(b, seat, n), 9, 'n=' + n + ' 座位 ' + seat + ' 9 子入营');
      assert.equal(R.isHome(b, seat, n), false);
      b[goalIds[9]] = seat;
      assert.equal(R.inGoal(b, seat, n), 10);
      assert.equal(R.isHome(b, seat, n), true);
      // 目标营里换成别的座位的子不算
      const wrong = emptyBoard();
      for (const id of goalIds) wrong[id] = (seat + 1) % n;
      assert.equal(R.inGoal(wrong, seat, n), 0, '目标营里是别人的子不算入营');
    }
  }
});

t('detectWin：各座位都能被检出（座位 0 返回 0，不能当 false）', () => {
  for (const n of [2, 3, 4, 5, 6]) {
    for (let seat = 0; seat < n; seat++) {
      const b = emptyBoard();
      for (const id of R.seatGoalIds(seat, n)) b[id] = seat;
      const w = R.detectWin(b, n);
      assert.equal(w, seat, 'n=' + n + ' 座位 ' + seat + ' 获胜应返回座位号，实际 ' + w);
      assert.ok(w >= 0, 'n=' + n + ' 座位 ' + seat + ' 的胜者 >= 0');
    }
  }
  // 座位 0 获胜的真假值陷阱
  const b0 = emptyBoard();
  for (const id of R.seatGoalIds(0, 6)) b0[id] = 0;
  assert.equal(R.detectWin(b0, 6), 0);
  assert.equal(R.detectWin(b0, 6) === 0, true);
  assert.equal(R.detectWin(b0, 6) >= 0, true);
  // 无胜者返回 -1；差一子也返回 -1
  assert.equal(R.detectWin(emptyBoard(), 3), -1);
  const nine = emptyBoard();
  for (const id of R.seatGoalIds(0, 6).slice(0, 9)) nine[id] = 0;
  assert.equal(R.detectWin(nine, 6), -1);
  assert.equal(R.detectWin(R.initialBoard(6), 6), -1);
});

t('hasAnyMove：各座位初始能走、空盘不能走', () => {
  for (const n of R.PLAYER_COUNTS) {
    const b = R.initialBoard(n);
    for (let seat = 0; seat < n; seat++) assert.equal(R.hasAnyMove(b, seat), true, 'n=' + n + ' 座位 ' + seat);
  }
  assert.equal(R.hasAnyMove(emptyBoard(), 0), false);
  const onlyZero = emptyBoard();
  onlyZero[centerId] = 0;
  assert.equal(R.hasAnyMove(onlyZero, 0), true);
  assert.equal(R.hasAnyMove(onlyZero, 1), false);
});

/* ---------------- 其他工具 ---------------- */

t('otherSeat / cloneBoard / holeAt 基础工具', () => {
  assert.equal(R.otherSeat(0, 2), 1);
  assert.equal(R.otherSeat(1, 2), 0);
  assert.equal(R.otherSeat(0, 3), 1);
  assert.equal(R.otherSeat(2, 3), 0);
  assert.equal(R.otherSeat(5, 6), 0);
  const b = R.initialBoard(3);
  const c = R.cloneBoard(b);
  assert.notEqual(c, b);
  assert.deepEqual(c, b);
  const ownerId = R.seatHomeIds(0, 3)[0];
  c[ownerId] = 999;
  assert.equal(b[ownerId], 0, 'clone 后改副本不影响原棋盘');
});

/* ---------------- 汇总 ---------------- */

if (problems.length) {
  console.error('\n❌ 规则引擎测试失败 ' + problems.length + ' 项：\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('✅ 规则引擎通过 ' + passed + ' 项');
