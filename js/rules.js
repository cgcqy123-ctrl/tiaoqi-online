// 中国跳棋规则引擎：星形棋盘（121 孔）、六向走/跳、连跳、入营判定
// 纯函数、零依赖，浏览器和 Node 都能直接跑（不碰 DOM、不碰网络）。
//
// 棋盘：六角星 = 中心六边形（半径 4，61 孔）+ 六个三角营（各 10 孔），共 121 孔。
// 坐标用立方坐标 (x, y, z)，x + y + z = 0；换算成轴向 (q, r) = (x, z) 再算屏幕像素。
// 玩家：红方（r）从下方营出发，目标是对面上方营；蓝方（b）反之。
// 一方把自己的 10 颗棋子全部走进对面营，即获胜。

export const RED = 'r';
export const BLUE = 'b';
export const SIDE_NAME = { r: '红', b: '蓝' };

const SQRT3 = Math.sqrt(3);

/** 轴向六方向（q, r） */
export const DIRS = [
  [1, -1],
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
];

/** 是否星形棋盘上的一格 */
function isStarCell(x, y, z) {
  if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) <= 4) return true; // 中心六边形
  // 六个尖角：恰好一个坐标在 [5,8] 或 [-8,-5]，另两个坐标在 [-4,4]
  const coords = [x, y, z];
  const tips = coords.filter((v) => Math.abs(v) >= 5 && Math.abs(v) <= 8).length;
  if (tips !== 1) return false;
  return coords.filter((v) => Math.abs(v) <= 4).length === 2;
}

/** 生成 121 个孔，按行（r）再按列（q）排序，id 稳定 */
function buildHoles() {
  const list = [];
  for (let r = -8; r <= 8; r++) {
    for (let q = -8; q <= 8; q++) {
      const x = q;
      const z = r;
      const y = -x - z;
      if (y < -8 || y > 8) continue;
      if (!isStarCell(x, y, z)) continue;
      list.push({ id: list.length, q, r, x, y, z });
    }
  }
  return list;
}

export const HOLES = buildHoles();
export const SIZE = HOLES.length;

/** q,r → 孔 id；不在棋盘上返回 -1 */
const KEY = new Map(HOLES.map((h) => [h.q + ',' + h.r, h.id]));
export function holeAt(q, r) {
  const id = KEY.get(q + ',' + r);
  return id === undefined ? -1 : id;
}

/* ---------------- 屏幕坐标（pointy-top 布局，viewBox 用） ---------------- */

let minX = Infinity;
let minY = Infinity;
let maxX = -Infinity;
let maxY = -Infinity;
for (const h of HOLES) {
  h.px = SQRT3 * (h.q + h.r / 2);
  h.py = 1.5 * h.r;
  minX = Math.min(minX, h.px);
  minY = Math.min(minY, h.py);
  maxX = Math.max(maxX, h.px);
  maxY = Math.max(maxY, h.py);
}
const PAD = 1.5;
export const VIEW = {
  x: minX - PAD,
  y: minY - PAD,
  w: maxX - minX + PAD * 2,
  h: maxY - minY + PAD * 2,
};

/** 六角星外轮廓：两个大三角拼成（营与营之间），供界面画棋盘底色 */
export const BOARD_TRIANGLES = [
  [[0, -12], [6 * SQRT3, 6], [-6 * SQRT3, 6]],
  [[0, 12], [6 * SQRT3, -6], [-6 * SQRT3, -6]],
];

/** 营：红方在下方（z >= 5），蓝方在上方（z <= -5） */
export const HOME_BOTTOM = HOLES.filter((h) => h.z >= 5).map((h) => h.id);
export const HOME_TOP = HOLES.filter((h) => h.z <= -5).map((h) => h.id);

/** side → 出发营 / 目标营 */
export const START_HOME = { r: HOME_BOTTOM, b: HOME_TOP };
export const GOAL_HOME = { r: HOME_TOP, b: HOME_BOTTOM };

/** 两个营的三角形轮廓（界面标色用） */
export const HOME_TRIANGLES = {
  r: [[-1.5 * SQRT3, 7.5], [1.5 * SQRT3, 7.5], [0, 12]],
  b: [[-1.5 * SQRT3, -7.5], [1.5 * SQRT3, -7.5], [0, -12]],
};

/* ---------------- 基础工具 ---------------- */

export const other = (side) => (side === RED ? BLUE : RED);
export const sideName = (side) => SIDE_NAME[side] || '';

export function initialBoard() {
  const board = new Array(SIZE).fill(null);
  for (const id of HOME_BOTTOM) board[id] = RED;
  for (const id of HOME_TOP) board[id] = BLUE;
  return board;
}

export function cloneBoard(board) {
  return board.slice();
}

/** 某方在目标营里的棋子数（界面显示进度用） */
export function inGoal(board, side) {
  let n = 0;
  for (const id of GOAL_HOME[side]) if (board[id] === side) n++;
  return n;
}

/** 某方是否已经全部入营 */
export function isHome(board, side) {
  return inGoal(board, side) === 10;
}

/** 全盘检查胜负：返回 { side } 或 null */
export function detectWin(board) {
  if (isHome(board, RED)) return { side: RED };
  if (isHome(board, BLUE)) return { side: BLUE };
  return null;
}

/* ---------------- 走子 / 连跳 ---------------- */

/**
 * 某个子的全部可达落点。返回 Map<落点 id, 路径数组 [from, ..., to]>。
 * 规则：要么走一步到相邻空格，要么连续跳（跳过的位置必须是任意一方的棋子，
 * 落点必须是空格，同一回合不能重复经过同一孔）。
 */
export function reachable(board, from) {
  const out = new Map();
  if (from < 0 || from >= SIZE || !board[from]) return out;
  const h = HOLES[from];

  // 1) 走一步
  for (const [dq, dr] of DIRS) {
    const to = holeAt(h.q + dq, h.r + dr);
    if (to >= 0 && !board[to]) out.set(to, [from, to]);
  }

  // 2) 连跳（不允许和走一步混在同一手）
  const seen = new Set([from]);
  const stack = [{ id: from, path: [from] }];
  while (stack.length) {
    const cur = stack.pop();
    const c = HOLES[cur.id];
    for (const [dq, dr] of DIRS) {
      const mid = holeAt(c.q + dq, c.r + dr);
      if (mid < 0 || !board[mid]) continue; // 中间必须有棋子
      const land = holeAt(c.q + dq * 2, c.r + dr * 2);
      if (land < 0 || board[land] || seen.has(land)) continue;
      seen.add(land);
      const path = cur.path.concat(land);
      out.set(land, path);
      stack.push({ id: land, path });
    }
  }
  return out;
}

/** 某个子的全部合法走法（数组，每项 { to, path }） */
export function legalMoves(board, from) {
  return [...reachable(board, from)].map(([to, path]) => ({ to, path }));
}

/** 两个相邻孔之间的位移方向；不是相邻返回 null */
function stepDir(a, b) {
  const dq = b.q - a.q;
  const dr = b.r - a.r;
  return DIRS.find(([dq0, dr0]) => dq0 === dq && dr0 === dr) || null;
}

/** 这一手是不是「走一步」 */
export function isStep(path) {
  if (!Array.isArray(path) || path.length !== 2) return false;
  return !!stepDir(HOLES[path[0]], HOLES[path[1]]);
}

/** 这一手跳了几下（走一步算 0） */
export function jumpCount(path) {
  if (!Array.isArray(path) || path.length < 2) return 0;
  return isStep(path) ? 0 : path.length - 1;
}

/**
 * 校验路径是否合法（path[0] 必须是 from）。
 * 路径只记录落点：走一步是 [from, to]，一次跳是 [from, landing]，连跳是 [from, l1, l2, ...]。
 */
export function isLegalMove(board, from, path) {
  if (!Array.isArray(path) || path.length < 2 || path[0] !== from) return false;
  if (from < 0 || from >= SIZE || !board[from]) return false;
  const dest = path[path.length - 1];
  if (dest < 0 || dest >= SIZE || board[dest]) return false;

  const seen = new Set([from]);
  let allJumps = true;
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const next = path[i];
    if (prev < 0 || prev >= SIZE || next < 0 || next >= SIZE) return false;
    if (seen.has(next)) return false;
    seen.add(next);
    if (board[next]) return false;
    const a = HOLES[prev];
    const b = HOLES[next];
    if (stepDir(a, b)) {
      if (path.length !== 2) return false; // 走一步不能和跳混合
      allJumps = false;
      continue;
    }
    // 其余只可能是「隔一个棋子跳两格」
    const dq = b.q - a.q;
    const dr = b.r - a.r;
    if (dq % 2 !== 0 || dr % 2 !== 0) return false;
    const dir = DIRS.find(([dq0, dr0]) => dq0 === dq / 2 && dr0 === dr / 2);
    if (!dir) return false;
    const mid = holeAt(a.q + dir[0], a.r + dir[1]);
    if (mid < 0 || !board[mid]) return false;
  }
  return true;
}

/** 落子后的新棋盘（不修改原棋盘）：起点清空，终点放上棋子 */
export function applyMove(board, from, path) {
  const next = board.slice();
  const side = next[from];
  next[from] = null;
  next[path[path.length - 1]] = side;
  return { board: next, side, to: path[path.length - 1] };
}

/** 这一手是走一步还是跳了几下 */
export function moveNotation(path) {
  const jumps = jumpCount(path);
  return jumps <= 0 ? '走 1 步' : '跳 ' + jumps + ' 下';
}

/** 某方是否还有棋可走 */
export function hasAnyMove(board, side) {
  for (let i = 0; i < SIZE; i++) {
    if (board[i] !== side) continue;
    if (reachable(board, i).size > 0) return true;
  }
  return false;
}
