// 中国跳棋规则引擎（2-6 人）：星形棋盘（121 孔）、六向走/跳、连跳、入营判定
// 纯函数、零依赖，浏览器和 Node 都能直接跑（不碰 DOM、不碰网络）。
//
// 棋盘：六角星 = 中心六边形（半径 4，61 孔）+ 六个三角营（各 10 孔），共 121 孔。
// 坐标用立方坐标 (x, y, z)，x + y + z = 0；换算成轴向 (q, r) = (x, z) 再算屏幕像素。
// 座位号 0-5 直接作为棋子编码（0 也是有效棋子，判空必须用 === null）。
// 每个座位占一个营，目标是对面那个营；谁先把自己 10 颗棋子全部送进目标营谁获胜。

export const SIZE = 121;

/** 座位颜色名（0-5），界面据此取色 */
export const SEAT_NAMES = ['红', '蓝', '绿', '橙', '紫', '青'];

export const PLAYER_COUNTS = [2, 3, 4, 5, 6];

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
  const coords = [x, y, z];
  const tips = coords.filter((v) => Math.abs(v) >= 5 && Math.abs(v) <= 8).length;
  if (tips !== 1) return false;
  return coords.filter((v) => Math.abs(v) <= 4).length === 2;
}

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

const KEY = new Map(HOLES.map((h) => [h.q + ',' + h.r, h.id]));
export function holeAt(q, r) {
  const id = KEY.get(q + ',' + r);
  return id === undefined ? -1 : id;
}

/* ---------------- 屏幕坐标 ---------------- */

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

/** 六角星外轮廓：两个大三角 */
export const BOARD_TRIANGLES = [
  [[0, -12], [6 * SQRT3, 6], [-6 * SQRT3, 6]],
  [[0, 12], [6 * SQRT3, -6], [-6 * SQRT3, -6]],
];

/* ---------------- 六个营 ---------------- */

/** 顺时针（从下方营开始）：下、左下、左上、上、右上、右下 */
export const CAMP_KEYS = ['z+', 'x-', 'y+', 'z-', 'x+', 'y-'];

const CAMP_FILTERS = {
  'z+': (h) => h.z >= 5 && h.z <= 8,
  'z-': (h) => h.z <= -5 && h.z >= -8,
  'x+': (h) => h.x >= 5 && h.x <= 8,
  'x-': (h) => h.x <= -5 && h.x >= -8,
  'y+': (h) => h.y >= 5 && h.y <= 8,
  'y-': (h) => h.y <= -5 && h.y >= -8,
};

/** 凸包（单调链），用于算营的三角形轮廓 */
function convexHull(points) {
  const pts = points.slice().sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (pts.length <= 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 六个营：{ key, ids[10], tri(三角形轮廓), center:{px,py}, goal(对面营下标) } */
export const CAMPS = CAMP_KEYS.map((key, index) => {
  const filter = CAMP_FILTERS[key];
  const ids = HOLES.filter(filter).map((h) => h.id);
  const tri = convexHull(ids.map((id) => [HOLES[id].px, HOLES[id].py]));
  let cx = 0;
  let cy = 0;
  for (const id of ids) { cx += HOLES[id].px; cy += HOLES[id].py; }
  return {
    key,
    index,
    ids,
    tri,
    center: { px: cx / ids.length, py: cy / ids.length },
    goal: (index + 3) % 6,
  };
});

/** 各人数下座位 0..n-1 使用的营（营下标，顺时针） */
const CAMP_SETS = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [1, 2, 4, 5],
  5: [0, 1, 2, 3, 4],
  6: [0, 1, 2, 3, 4, 5],
};

export function campsForCount(count) {
  const n = PLAYER_COUNTS.includes(Number(count)) ? Number(count) : 2;
  return CAMP_SETS[n].slice();
}

/** 某座位（0..n-1）的出发营 / 目标营（营下标） */
export function seatCamp(seat, count) {
  return campsForCount(count)[seat];
}
export function seatGoalCamp(seat, count) {
  return CAMPS[seatCamp(seat, count)].goal;
}

/** 某座位出发营 / 目标营的孔 id 数组 */
export function seatHomeIds(seat, count) {
  return CAMPS[seatCamp(seat, count)].ids;
}
export function seatGoalIds(seat, count) {
  return CAMPS[seatGoalCamp(seat, count)].ids;
}

/* ---------------- 基础工具 ---------------- */

const isEmpty = (v) => v === null || v === undefined;

export function otherSeat(seat, count) {
  return (seat + 1) % count;
}

export function cloneBoard(board) {
  return board.slice();
}

/** 2-6 人的开局棋盘：每个座位 10 子放在自己的出发营，棋子值 = 座位号 */
export function initialBoard(count = 2) {
  const n = PLAYER_COUNTS.includes(Number(count)) ? Number(count) : 2;
  const board = new Array(SIZE).fill(null);
  const camps = campsForCount(n);
  for (let seat = 0; seat < n; seat++) {
    for (const id of CAMPS[camps[seat]].ids) board[id] = seat;
  }
  return board;
}

/** 某方在目标营里的棋子数（界面显示入营进度） */
export function inGoal(board, seat, count) {
  let n = 0;
  for (const id of seatGoalIds(seat, count)) if (board[id] === seat) n++;
  return n;
}

/** 某方是否全部入营 */
export function isHome(board, seat, count) {
  return inGoal(board, seat, count) === 10;
}

/** 全盘检查胜负：返回获胜座位号，暂时没有返回 -1 */
export function detectWin(board, count) {
  for (let seat = 0; seat < count; seat++) {
    if (isHome(board, seat, count)) return seat;
  }
  return -1;
}

/* ---------------- 走子 / 连跳 ---------------- */

/**
 * 某个子的全部可达落点。返回 Map<落点 id, 路径数组 [from, ..., to]>。
 * 规则：要么走一步到相邻空格，要么连续跳；同一回合不能重复经过同一孔。
 */
export function reachable(board, from) {
  const out = new Map();
  if (from < 0 || from >= SIZE || isEmpty(board[from])) return out;
  const h = HOLES[from];

  // 1) 走一步
  for (const [dq, dr] of DIRS) {
    const to = holeAt(h.q + dq, h.r + dr);
    if (to >= 0 && isEmpty(board[to])) out.set(to, [from, to]);
  }

  // 2) 连跳（不允许和走一步混在同一手）
  const seen = new Set([from]);
  const stack = [{ id: from, path: [from] }];
  while (stack.length) {
    const cur = stack.pop();
    const c = HOLES[cur.id];
    for (const [dq, dr] of DIRS) {
      const mid = holeAt(c.q + dq, c.r + dr);
      if (mid < 0 || isEmpty(board[mid])) continue; // 中间必须有棋子
      const land = holeAt(c.q + dq * 2, c.r + dr * 2);
      if (land < 0 || !isEmpty(board[land]) || seen.has(land)) continue;
      seen.add(land);
      const path = cur.path.concat(land);
      out.set(land, path);
      stack.push({ id: land, path });
    }
  }
  return out;
}

/** 某个子的全部合法走法 */
export function legalMoves(board, from) {
  return [...reachable(board, from)].map(([to, path]) => ({ to, path }));
}

function stepDir(a, b) {
  const dq = b.q - a.q;
  const dr = b.r - a.r;
  return DIRS.find(([dq0, dr0]) => dq0 === dq && dr0 === dr) || null;
}

export function isStep(path) {
  if (!Array.isArray(path) || path.length !== 2) return false;
  return !!stepDir(HOLES[path[0]], HOLES[path[1]]);
}

export function jumpCount(path) {
  if (!Array.isArray(path) || path.length < 2) return 0;
  return isStep(path) ? 0 : path.length - 1;
}

/** 校验路径是否合法（路径只记录落点） */
export function isLegalMove(board, from, path) {
  if (!Array.isArray(path) || path.length < 2 || path[0] !== from) return false;
  if (from < 0 || from >= SIZE || isEmpty(board[from])) return false;
  const dest = path[path.length - 1];
  if (dest < 0 || dest >= SIZE || !isEmpty(board[dest])) return false;

  const seen = new Set([from]);
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const next = path[i];
    if (prev < 0 || prev >= SIZE || next < 0 || next >= SIZE) return false;
    if (seen.has(next)) return false;
    seen.add(next);
    if (!isEmpty(board[next])) return false;
    const a = HOLES[prev];
    const b = HOLES[next];
    if (stepDir(a, b)) {
      if (path.length !== 2) return false; // 走一步不能和跳混合
      continue;
    }
    const dq = b.q - a.q;
    const dr = b.r - a.r;
    if (dq % 2 !== 0 || dr % 2 !== 0) return false;
    const dir = DIRS.find(([dq0, dr0]) => dq0 === dq / 2 && dr0 === dr / 2);
    if (!dir) return false;
    const mid = holeAt(a.q + dir[0], a.r + dir[1]);
    if (mid < 0 || isEmpty(board[mid])) return false;
  }
  return true;
}

export function applyMove(board, from, path) {
  const next = board.slice();
  const seat = next[from];
  next[from] = null;
  next[path[path.length - 1]] = seat;
  return { board: next, seat, to: path[path.length - 1] };
}

export function moveNotation(path) {
  const jumps = jumpCount(path);
  return jumps <= 0 ? '走 1 步' : '跳 ' + jumps + ' 下';
}

export function hasAnyMove(board, seat) {
  for (let i = 0; i < SIZE; i++) {
    if (board[i] !== seat) continue;
    if (reachable(board, i).size > 0) return true;
  }
  return false;
}
