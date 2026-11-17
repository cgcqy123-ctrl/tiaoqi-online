// 中国跳棋规则引擎单元测试（零依赖，纯 node）：node test/rules.test.mjs
// 风格对齐五子棋/象棋项目 test/：problems 收集 + ✅/❌ + process.exit(1)
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

/* ---------------- 棋盘数据 ---------------- */

t('棋盘规格：121 孔、立方坐标、holeAt 互逆', () => {
  assert.equal(R.SIZE, 121);
  assert.equal(R.HOLES.length, 121);
  assert.ok(R.HOLES.every((h, i) => h.id === i), 'id 与下标一致');
  assert.ok(R.HOLES.every((h) => h.x + h.y + h.z === 0), '立方坐标 x+y+z=0');

  const keys = new Set(R.HOLES.map((h) => h.q + ',' + h.r));
  assert.equal(keys.size, 121, '(q,r) 不重复');
  for (const h of R.HOLES) assert.equal(R.holeAt(h.q, h.r), h.id, 'holeAt 互逆 ' + coord(h.id));
  assert.equal(R.holeAt(99, 0), -1);
  assert.equal(R.holeAt(0, 99), -1);
  assert.equal(R.holeAt(5, 5), -1, 'y=-10 越界');

  // 六角星 = 中心六边形（半径 4）61 孔 + 六个尖角各 10 孔
  const inCenter = R.HOLES.filter((h) => Math.max(Math.abs(h.x), Math.abs(h.y), Math.abs(h.z)) <= 4);
  const tips = R.HOLES.filter((h) => {
    const v = [h.x, h.y, h.z];
    const tip = v.filter((n) => Math.abs(n) >= 5 && Math.abs(n) <= 8).length;
    const inner = v.filter((n) => Math.abs(n) <= 4).length;
    return tip === 1 && inner === 2;
  });
  assert.equal(inCenter.length, 61);
  assert.equal(tips.length, 60);
  assert.equal(inCenter.length + tips.length, R.SIZE);
  assert.ok(R.HOLES.every((h) => Math.max(Math.abs(h.x), Math.abs(h.y), Math.abs(h.z)) <= 8), '没有超出星形的孔');
  assert.equal(centerId, 60, '中心孔 (q0,r0) 是 60 号');
  const center = R.HOLES[centerId];
  assert.equal(center.id, 60);
  assert.equal(center.q, 0);
  assert.equal(center.r, 0);
  assert.equal(center.x, 0);
  assert.equal(Math.abs(center.y), 0, 'y 可能是 -0，取绝对值判断');
  assert.equal(center.z, 0);
  assert.equal(center.px, 0);
  assert.equal(center.py, 0);
});

t('像素坐标与 VIEW 合理', () => {
  for (const h of R.HOLES) {
    assert.ok(Math.abs(h.px - SQRT3 * (h.q + h.r / 2)) < 1e-12, 'px 公式 ' + coord(h.id));
    assert.ok(Math.abs(h.py - 1.5 * h.r) < 1e-12, 'py 公式 ' + coord(h.id));
  }
  const V = R.VIEW;
  assert.ok([V.x, V.y, V.w, V.h].every((n) => typeof n === 'number' && Number.isFinite(n)), 'VIEW 四个数都是有限数');
  assert.ok(V.w > 0 && V.h > 0, 'VIEW 宽高为正');
  for (const h of R.HOLES) {
    assert.ok(h.px >= V.x && h.px <= V.x + V.w, '像素 x 在 viewBox 内 ' + coord(h.id));
    assert.ok(h.py >= V.y && h.py <= V.y + V.h, '像素 y 在 viewBox 内 ' + coord(h.id));
  }
});

t('DIRS：6 个方向、向量相反成对', () => {
  assert.equal(R.DIRS.length, 6);
  const set = new Set(R.DIRS.map(([q, r]) => q + ',' + r));
  assert.equal(set.size, 6, '6 个方向互不重复');
  for (const [q, r] of R.DIRS) {
    assert.ok(Number.isInteger(q) && Number.isInteger(r), '方向是整数向量');
    assert.ok(set.has(-q + ',' + -r), '反方向存在：' + q + ',' + r);
  }
});

t('营：上下各 10 孔，起点营与目标营互换', () => {
  assert.equal(R.HOME_BOTTOM.length, 10);
  assert.equal(R.HOME_TOP.length, 10);
  assert.ok(R.HOME_BOTTOM.every((id) => R.HOLES[id].z >= 5), '下方营 z>=5');
  assert.ok(R.HOME_TOP.every((id) => R.HOLES[id].z <= -5), '上方营 z<=-5');
  assert.ok(R.HOME_BOTTOM.every((id) => R.HOLES[id].py > 0), '下方营像素 y>0');
  assert.ok(R.HOME_TOP.every((id) => R.HOLES[id].py < 0), '上方营像素 y<0');
  assert.equal(new Set(R.HOME_BOTTOM).size, 10);
  assert.equal(new Set(R.HOME_TOP).size, 10);
  assert.ok(R.HOME_BOTTOM.every((id) => !R.HOME_TOP.includes(id)), '两个营不重叠');
  assert.equal(R.START_HOME.r, R.HOME_BOTTOM);
  assert.equal(R.START_HOME.b, R.HOME_TOP);
  assert.equal(R.GOAL_HOME.r, R.HOME_TOP);
  assert.equal(R.GOAL_HOME.b, R.HOME_BOTTOM);
});

t('棋盘/营三角数据可用于绘制 SVG', () => {
  assert.equal(R.BOARD_TRIANGLES.length, 2);
  for (const tri of R.BOARD_TRIANGLES) {
    assert.equal(tri.length, 3);
    for (const [x, y] of tri) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  }
  assert.equal(R.HOME_TRIANGLES.r.length, 3);
  assert.equal(R.HOME_TRIANGLES.b.length, 3);
  assert.ok(R.HOME_TRIANGLES.r.every((p) => p[1] > 0), '红方营三角在下方（y>0）');
  assert.ok(R.HOME_TRIANGLES.b.every((p) => p[1] < 0), '蓝方营三角在上方（y<0）');
});

/* ---------------- 基础工具 / 初始局面 ---------------- */

t('other / sideName / cloneBoard', () => {
  assert.equal(R.RED, 'r');
  assert.equal(R.BLUE, 'b');
  assert.deepEqual(R.SIDE_NAME, { r: '红', b: '蓝' });
  assert.equal(R.other('r'), 'b');
  assert.equal(R.other('b'), 'r');
  assert.equal(R.sideName('r'), '红');
  assert.equal(R.sideName('b'), '蓝');
  assert.equal(R.sideName('x'), '');
  const b = R.initialBoard();
  const c = R.cloneBoard(b);
  assert.notEqual(c, b);
  assert.deepEqual(c, b);
  c[0] = 'r';
  assert.equal(b[0], 'b', '改副本不影响原棋盘');
});

t('初始棋盘：红蓝各 10 子都在各自出发营', () => {
  const b = R.initialBoard();
  assert.equal(b.length, 121);
  assert.equal(b.filter((x) => x === R.RED).length, 10);
  assert.equal(b.filter((x) => x === R.BLUE).length, 10);
  for (const id of R.HOME_BOTTOM) assert.equal(b[id], R.RED, '红方出发营 ' + coord(id));
  for (const id of R.HOME_TOP) assert.equal(b[id], R.BLUE, '蓝方出发营 ' + coord(id));
  assert.ok(b.every((x) => x === null || x === R.RED || x === R.BLUE), '只有空格和两色棋子');
  assert.equal(R.inGoal(b, R.RED), 0);
  assert.equal(R.inGoal(b, R.BLUE), 0);
  assert.equal(R.detectWin(b), null);
});

t('初始局面双方各 14 种走法且全部合法', () => {
  const b = R.initialBoard();
  const all = (side) => {
    const out = [];
    for (let i = 0; i < R.SIZE; i++) {
      if (b[i] !== side) continue;
      for (const m of R.legalMoves(b, i)) out.push({ from: i, ...m });
    }
    return out;
  };
  const red = all(R.RED);
  const blue = all(R.BLUE);
  assert.equal(red.length, 14);
  assert.equal(blue.length, 14);
  for (const m of red.concat(blue)) {
    assert.ok(R.isLegalMove(b, m.from, m.path), '合法走法 ' + coord(m.from));
    assert.equal(m.path[0], m.from);
    assert.equal(m.to, m.path[m.path.length - 1]);
  }
  assert.equal(R.hasAnyMove(b, R.RED), true);
  assert.equal(R.hasAnyMove(b, R.BLUE), true);
});

/* ---------------- 走一步 / 跳 / 连跳 ---------------- */

t('走一步：路径 [from,to]，原棋盘不变', () => {
  const b = R.initialBoard();
  const snapshot = b.join(',');
  const from = 111;
  const to = 103;
  const path = [from, to];
  assert.ok(R.isLegalMove(b, from, path));
  assert.ok(R.isStep(path));
  assert.equal(R.jumpCount(path), 0);
  assert.equal(R.moveNotation(path), '走 1 步');
  assert.ok(R.legalMoves(b, from).some((m) => m.to === to && m.path.join(',') === path.join(',')), 'legalMoves 含 111→103');
  assert.deepEqual(R.reachable(b, from).get(to), path);

  const { board, side, to: dest } = R.applyMove(b, from, path);
  assert.equal(side, R.RED);
  assert.equal(dest, to);
  assert.equal(board[from], null);
  assert.equal(board[to], R.RED);
  assert.equal(b.join(','), snapshot, 'applyMove 不修改原棋盘');
});

t('跳：隔一个棋子跳两格，路径只记录落点', () => {
  const b = emptyBoard();
  b[centerId] = R.RED;
  b[51] = R.BLUE; // 60→41 中间的棋子
  const path = [centerId, 41];
  assert.ok(R.isLegalMove(b, centerId, path));
  assert.equal(R.jumpCount(path), 1);
  assert.equal(R.moveNotation(path), '跳 1 下');
  const reach = R.reachable(b, centerId);
  assert.ok(reach instanceof Map);
  assert.deepEqual(reach.get(41), path, '路径只记录落点，不含被跳过的孔');
  assert.equal(reach.has(51), false, '被占的孔不是落点');

  // 跳过的可以是任意一方的棋子（包括自己的）
  const own = emptyBoard();
  own[centerId] = R.RED;
  own[51] = R.RED;
  assert.ok(R.isLegalMove(own, centerId, path), '可以跳过自己的棋子');
});

t('连跳：一次跳多下，落点序列构成路径', () => {
  const b = emptyBoard();
  b[centerId] = R.RED; // 60
  b[51] = R.BLUE; // 60→41 的中间子
  b[30] = R.RED; // 41→18 的中间子
  const path = [centerId, 41, 18];
  assert.ok(R.isLegalMove(b, centerId, path));
  assert.equal(R.jumpCount(path), 2);
  assert.equal(R.moveNotation(path), '跳 2 下');
  assert.ok(!R.isStep([path[0], path[1]]), '连跳的每段都是隔子跳两格');
  assert.deepEqual(R.reachable(b, centerId).get(18), path);
  const { board, side, to } = R.applyMove(b, centerId, path);
  assert.equal(side, R.RED);
  assert.equal(to, 18);
  assert.equal(board[centerId], null);
  assert.equal(board[18], R.RED);
});

t('不能落子到有子的孔', () => {
  const b = emptyBoard();
  b[centerId] = R.RED;
  b[51] = R.BLUE;
  assert.equal(R.isLegalMove(b, centerId, [centerId, 51]), false, '走一步撞子');
  assert.equal(R.isLegalMove(b, centerId, [centerId, 41]), true, '隔子跳可以');
  const reach = R.reachable(b, centerId);
  for (const [, path] of reach) {
    assert.equal(b[path[path.length - 1]], null, '所有可达落点都是空格');
  }
  assert.equal(R.legalMoves(b, centerId).some((m) => m.to === 51), false);
});

t('伪装路径一律拒绝', () => {
  const b = emptyBoard();
  b[centerId] = R.RED;
  b[51] = R.BLUE;
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
  emptyMid[centerId] = R.RED;
  bad('中间没有棋子却跳两格', emptyMid, centerId, [centerId, 41]);

  const mix = emptyBoard();
  mix[centerId] = R.RED;
  mix[41] = R.BLUE; // 51→30 的中间子
  bad('走一步 + 跳混合', mix, centerId, [centerId, 51, 30]);

  bad('跳三格（不是跳两格）', b, centerId, [centerId, 30]);
  bad('不对齐的双倍位移', b, centerId, [centerId, R.holeAt(2, 2)]);
  bad('奇数位移', b, centerId, [centerId, R.holeAt(1, -2)]);

  const occupiedMidLanding = emptyBoard();
  occupiedMidLanding[centerId] = R.RED;
  occupiedMidLanding[41] = R.BLUE;
  bad('连跳中途落点有子', occupiedMidLanding, centerId, [centerId, 41, 18]);
});

t('reachable / legalMoves 返回的每一步都合法', () => {
  const b = emptyBoard();
  b[centerId] = R.RED;
  b[51] = R.BLUE;
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
  // 空格 / 非法起点返回空
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
  assert.equal(R.jumpCount('x'), 0);
  assert.equal(R.isStep([111, 103]), true);
  assert.equal(R.isStep([centerId, 41]), false, '跳两格不是走一步');
  assert.equal(R.isStep([centerId, 41, 18]), false);
  assert.equal(R.isStep([111]), false);
  assert.equal(R.isStep(null), false);
});

/* ---------------- 入营 / 胜负 ---------------- */

t('入营判定与胜负检测', () => {
  const empty = emptyBoard();
  assert.equal(R.inGoal(empty, R.RED), 0);
  assert.equal(R.inGoal(empty, R.BLUE), 0);
  assert.equal(R.isHome(empty, R.RED), false);
  assert.equal(R.isHome(empty, R.BLUE), false);
  assert.equal(R.detectWin(empty), null);

  const red9 = emptyBoard();
  for (const id of R.HOME_TOP.slice(0, 9)) red9[id] = R.RED;
  assert.equal(R.inGoal(red9, R.RED), 9);
  assert.equal(R.isHome(red9, R.RED), false);
  assert.equal(R.detectWin(red9), null);

  const red10 = emptyBoard();
  for (const id of R.HOME_TOP) red10[id] = R.RED;
  assert.equal(R.inGoal(red10, R.RED), 10);
  assert.equal(R.isHome(red10, R.RED), true);
  assert.deepEqual(R.detectWin(red10), { side: R.RED });

  const blue10 = emptyBoard();
  for (const id of R.HOME_BOTTOM) blue10[id] = R.BLUE;
  assert.equal(R.inGoal(blue10, R.BLUE), 10);
  assert.equal(R.isHome(blue10, R.BLUE), true);
  assert.deepEqual(R.detectWin(blue10), { side: R.BLUE });

  // 目标营里放的是对手的子，不算自己入营
  const wrong = emptyBoard();
  for (const id of R.HOME_TOP) wrong[id] = R.BLUE;
  assert.equal(R.inGoal(wrong, R.RED), 0);

  assert.equal(R.detectWin(R.initialBoard()), null, '初始棋盘谁也不赢');
});

t('hasAnyMove：初始双方能走、空盘不能走', () => {
  const b = R.initialBoard();
  assert.equal(R.hasAnyMove(b, R.RED), true);
  assert.equal(R.hasAnyMove(b, R.BLUE), true);
  assert.equal(R.hasAnyMove(emptyBoard(), R.RED), false);
  assert.equal(R.hasAnyMove(emptyBoard(), R.BLUE), false);
  const onlyRed = emptyBoard();
  onlyRed[centerId] = R.RED;
  assert.equal(R.hasAnyMove(onlyRed, R.RED), true);
  assert.equal(R.hasAnyMove(onlyRed, R.BLUE), false);
});

/* ---------------- 汇总 ---------------- */

if (problems.length) {
  console.error('\n❌ 规则引擎测试失败 ' + problems.length + ' 项：\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('✅ 规则引擎通过 ' + passed + ' 项');
