// 中国跳棋界面渲染与交互（2-6 人，只负责 DOM，不含规则判定与网络）
// 数据源：game.view(seat) 生成的视图对象；用户动作通过 actionCb 交给 main.js 转发。
// 座位号 0-5 就是棋子编码（0 也是有效棋子），所有判空必须用 === null。

const V = new URL(import.meta.url).search; // 跟随 index.html 的 ?v= 做缓存穿透
const R = await import('./rules.js' + V);

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const QUICK = ['你好 👋', '开局吧', '这步跳得漂亮', '手下留情', '再来一局？', '稳住'];

// 座位颜色（红/蓝/绿/橙/紫/青），与 CSS 里的 --seat-0..5 保持一致
const SEAT_COLORS = ['#e2523c', '#3f7fd9', '#35a35a', '#e08a2b', '#9a5fd0', '#21a6a6'];

// 棋盘几何：VIEW 已由 rules.js 算好（含留白），六角星是宽扁的
const RATIO = R.VIEW.w / R.VIEW.h;
const HOLE_R = '0.30';
const PIECE_R = '0.4';
const HINT_R = '0.46';
const HIT_R = '0.52';
const LAST_R = '0.5';

let actionCb = null;
let chatCb = null;
let boardSig = '';
let selected = -1; // 当前选中的棋子孔 id，-1 = 未选中
let reachable = new Map(); // 落点 id → 路径数组
// 连跳草稿：{ start, path, board, reach }。path 只记录落点；board 是棋子已走到当前落点的虚拟局面
let chain = null;
let lastView = null;
let toastTimer = 0;
let resignArmed = false;
let resignArmTimer = 0;
let quickReady = false;
let uiBound = false;

/* ---------------- 基础 ---------------- */

export function showScreen(name) {
  for (const id of ['home', 'lobby', 'table']) {
    const el = $('scr-' + id);
    if (el) el.classList.toggle('hidden', id !== name);
  }
  if (name === 'table') layoutBoard();
}

export function toast(msg, ms = 2400) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function setChatSender(fn) {
  chatCb = fn;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function btn(text, kind, fn) {
  const b = document.createElement('button');
  b.className = 'btn ' + kind;
  b.textContent = text;
  b.addEventListener('click', fn);
  return b;
}

/** 棋盘上的空格统一判空（座位 0 是有效棋子，所以不能用 !value） */
function isEmptyCell(v) {
  return v === null || v === undefined;
}

/** 视图里的玩家数（2-6）：优先 view.count，其次 players.length，兜底 2 */
function playerCountOf(view) {
  const n = Number(view && view.count);
  if (R.PLAYER_COUNTS.includes(n)) return n;
  const m = view && Array.isArray(view.players) ? view.players.length : 0;
  return R.PLAYER_COUNTS.includes(m) ? m : 2;
}

/** 座位 0..n-1 对应的营下标（view.camps 缺失时按人数兜底算） */
function campsOf(view) {
  const camps = view && view.camps;
  if (Array.isArray(camps) && camps.length >= 2) return camps;
  return R.campsForCount(playerCountOf(view));
}

/** 我的座位号（0-5）；观战/取不到返回 null（0 也要能正确返回） */
function mySeatOf(view) {
  if (!view) return null;
  if (Number.isInteger(view.mySide) && view.mySide >= 0) return view.mySide;
  if (view.spectator) return null;
  if (Number.isInteger(view.seat) && view.seat >= 0) return view.seat;
  return null;
}

function playerOfSeat(view, seat) {
  if (!view || !Array.isArray(view.players)) return null;
  return view.players.find((p) => p && p.seat === seat) || null;
}

function playerName(view, seat) {
  const p = playerOfSeat(view, seat);
  return p && p.name ? p.name : '玩家' + (Number(seat) + 1);
}

/* ---------------- 棋盘 SVG 工具 ---------------- */

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const val = attrs[key];
      if (val !== undefined && val !== null) el.setAttribute(key, String(val));
    }
  }
  return el;
}

function svgCircle(cx, cy, r, cls, id) {
  const c = svgEl('circle', { cx, cy, r, class: cls });
  if (id !== undefined && id !== null) c.setAttribute('data-id', String(id));
  return c;
}

function svgPolygon(points, cls) {
  const pts = (points || []).map((p) => p[0] + ',' + p[1]).join(' ');
  return svgEl('polygon', { points: pts, class: cls });
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** 把颜色向 target 混合 t（0-1），用来生成棋子渐变的亮部/暗部 */
function mixColor(hex, target, t) {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** 渐变定义：6 个座位的棋子高光 + 木色星盘（纯 SVG 内置，不引用外部资源） */
function buildDefs() {
  const defs = svgEl('defs');
  for (let seat = 0; seat < SEAT_COLORS.length; seat++) {
    const base = SEAT_COLORS[seat];
    const g = svgEl('radialGradient', { id: 'piece-' + seat, cx: '35%', cy: '30%', r: '78%' });
    g.appendChild(svgEl('stop', { offset: '0%', 'stop-color': mixColor(base, '#ffffff', 0.45) }));
    g.appendChild(svgEl('stop', { offset: '55%', 'stop-color': base }));
    g.appendChild(svgEl('stop', { offset: '100%', 'stop-color': mixColor(base, '#000000', 0.4) }));
    defs.appendChild(g);
  }
  const wood = svgEl('linearGradient', { id: 'board-wood', x1: '0', y1: '0', x2: '0.4', y2: '1' });
  wood.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#f6e3ba' }));
  wood.appendChild(svgEl('stop', { offset: '55%', 'stop-color': '#e4c48c' }));
  wood.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#c99f60' }));
  defs.appendChild(wood);
  return defs;
}

/* ---------------- 房间大厅 ---------------- */

export function renderLobby({
  code,
  players = [],
  spectators = [],
  isHost = false,
  canStart = false,
  tip = '',
  youSeat = -1,
  playerCount,
} = {}) {
  showScreen('lobby');

  const rawN = Number(playerCount);
  const n = R.PLAYER_COUNTS.includes(rawN)
    ? rawN
    : R.PLAYER_COUNTS.includes(players.length)
      ? players.length
      : 2;

  const codeEl = $('lobby-code');
  if (codeEl) codeEl.textContent = code || '----';

  const ul = $('seat-list');
  if (ul) {
    ul.innerHTML = '';
    for (let seat = 0; seat < n; seat++) {
      const p = players[seat] || { name: '', connected: false };
      const seatName = R.SEAT_NAMES[seat] || '座位' + (seat + 1);
      const li = document.createElement('li');
      li.className = 'seat-item c' + seat + (p.name ? ' filled' : '');
      li.innerHTML =
        `<span class="idx c${seat}">${seatName}</span>` +
        `<span class="nm">${p.name ? escapeHtml(p.name) : '空位'}` +
        `${p.name && seat === youSeat ? '（你）' : ''}` +
        `${p.name && p.connected === false ? ' <i>离线</i>' : ''}</span>` +
        `<span class="tag">${seat === 0 ? seatName + '方 · 先行' : seatName + '方'}</span>`;
      ul.appendChild(li);
    }
  }

  const specNames = (spectators || []).filter(Boolean);
  const specEl = $('lobby-spec');
  if (specEl) {
    specEl.textContent = specNames.length
      ? `观战：${specNames.join('、')}`
      : `满 ${n} 人后，多出来的人自动观战`;
  }

  const startBtn = $('btn-start');
  if (startBtn) {
    startBtn.classList.toggle('hidden', !isHost);
    startBtn.disabled = !canStart;
    const filled = players.filter((p) => p && p.name).length;
    startBtn.textContent = canStart ? '开始对局' : `等待玩家入座 (${filled}/${n})`;
  }

  const tipEl = $('lobby-tip');
  if (tipEl) {
    tipEl.textContent = tip || (isHost ? '把房号发给朋友，人齐后点「开始对局」' : '等待房主开始对局…');
  }
}

/* ---------------- 棋盘尺寸 ---------------- */

/** 用 #board-box 的宽高和星形宽高比，给 #board 设定合适尺寸 */
function layoutBoard() {
  const box = $('board-box');
  const board = $('board');
  if (!box || !board) return;
  const bw = box.clientWidth || 0;
  const bh = box.clientHeight || 0;
  if (bw > 40 && bh > 40) {
    const w = Math.round(Math.min(bw, bh * RATIO));
    const h = Math.round(w / RATIO);
    board.style.width = w + 'px';
    board.style.height = h + 'px';
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => layoutBoard());
  if (typeof window.ResizeObserver === 'function') {
    try {
      const ro = new window.ResizeObserver(() => layoutBoard());
      const box = document.getElementById('board-box');
      if (box) ro.observe(box);
    } catch (_) { /* 忽略：部分环境没有 ResizeObserver */ }
  }
}

/* ---------------- 棋桌 ---------------- */

export function resetSelection() {
  selected = -1;
  reachable = new Map();
  chain = null;
  boardSig = '';
  if (lastView) renderBoard(lastView, mySeatOf(lastView));
}

/**
 * 渲染棋桌。view 由 game.view(seat) 得出，另外可带 _code / _isHost / _spectators。
 * actionCb 负责把动作发给房主（本地直接调用 / 远端走网络）。
 */
export function renderTable(view, cb) {
  actionCb = cb;
  const mySeat = mySeatOf(view);
  const n = playerCountOf(view);
  const sig = (view.board ? view.board.join(',') : '') + '#' + view.turn + '#' + view.phase + '#' + n;
  if (sig !== boardSig) {
    boardSig = sig;
    selected = -1;
    reachable = new Map();
    chain = null;
  }
  lastView = view;
  showScreen('table');

  const codeEl = $('t-code');
  if (codeEl && view._code) codeEl.textContent = view._code;

  const roomEl = $('t-room');
  if (roomEl) {
    const names = (view.players || []).map((p) => (p && p.name) || '玩家');
    roomEl.textContent = `${n} 人局 · ${names.join(' vs ')}`;
  }

  const specEl = $('side-spec');
  if (specEl) {
    const specs = view._spectators || [];
    specEl.textContent = specs.length ? `观战 ${specs.length}` : '';
  }

  renderPlayers(view, mySeat);
  renderBoard(view, mySeat);
  renderMoves(view);
  renderOffers(view, mySeat);
  renderActions(view, mySeat);
  renderQuick();

  const ov = $('overlay');
  if (view.phase === 'over' && view.result) {
    if (!ov || ov.dataset.mode !== 'menu') renderResult(view, mySeat);
  } else if (!ov || ov.dataset.mode !== 'menu') {
    clearOverlay();
  }
  layoutBoard();
}

function renderPlayers(view, mySeat) {
  const root = $('t-players');
  if (!root) return;
  root.innerHTML = '';
  const goals = Array.isArray(view.goalCount) ? view.goalCount : [];
  for (const p of view.players || []) {
    if (!p) continue;
    const seat = p.seat;
    const chip = document.createElement('div');
    const active = view.phase === 'play' && view.turn === seat;
    const me = mySeat !== null && mySeat === seat;
    chip.className = 'player-chip' + (active ? ' active' : '') + (me ? ' me' : '');
    const goal = Number(goals[seat]) || 0;
    chip.innerHTML =
      `<span class="dot-side c${seat}"></span>` +
      `<span class="nm">${escapeHtml(p.name)}</span>` +
      (p.connected === false ? '<i class="off">离线</i>' : '') +
      `<span class="goal">入营 ${goal}/10</span>`;
    root.appendChild(chip);
  }
}

/** 全量重建 #board-svg：星形底盘 → 6 个营（谁的家 / 谁的目标）→ 孔 → 标记 → 棋子 → 提示 → 热区 */
function renderBoard(view, mySeat) {
  const svg = $('board-svg');
  if (!svg) return;
  svg.setAttribute('viewBox', `${R.VIEW.x} ${R.VIEW.y} ${R.VIEW.w} ${R.VIEW.h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  svg.appendChild(buildDefs());

  // 连跳草稿时用虚拟局面渲染（棋子已经“走”到当前落点，但还没提交）
  const board = chain ? chain.board : view.board;
  const hints = chain ? chain.reach : reachable;
  const current = chain ? chain.path[chain.path.length - 1] : selected;

  // 1) 两个大三角拼成六角星（木色底）
  for (const tri of R.BOARD_TRIANGLES) svg.appendChild(svgPolygon(tri, 'board-tri'));

  // 2) 六个营：有人的营上玩家色（opacity .22），空营暗色细边；目标营再画一圈该玩家颜色的虚线
  const camps = campsOf(view);
  for (let i = 0; i < R.CAMPS.length; i++) {
    const camp = R.CAMPS[i];
    const owner = camps.indexOf(i); // 占这个营的座位号，-1 = 空营
    const targeter = camps.indexOf((i + 3) % 6); // 目标营是 i 的座位号（营的对面营 = i+3）
    const cls = 'home-tri' + (owner >= 0 ? ' owner c' + owner : ' empty');
    svg.appendChild(svgPolygon(camp.tri, cls));
    if (targeter >= 0) svg.appendChild(svgPolygon(camp.tri, 'home-ring c' + targeter));
  }

  // 3) 121 个孔
  for (const h of R.HOLES) svg.appendChild(svgCircle(h.px, h.py, HOLE_R, 'hole', h.id));

  // 4) 上一步路径标记（起点 / 中间落点 / 终点都标）
  if (view.lastMove && Array.isArray(view.lastMove.path)) {
    for (const id of view.lastMove.path) {
      const h = R.HOLES[id];
      if (h) svg.appendChild(svgCircle(h.px, h.py, LAST_R, 'last', id));
    }
  }

  // 4.5) 连跳草稿路径（还没提交，用不同颜色标出来）
  if (chain) {
    for (const id of chain.path) {
      const h = R.HOLES[id];
      if (h) svg.appendChild(svgCircle(h.px, h.py, LAST_R - 0.04, 'chain', id));
    }
  }

  // 5) 棋子：按座位号上色（c0..c5），pointer-events: none，点击交给最上层热区
  for (let id = 0; id < board.length; id++) {
    const seat = board[id];
    if (isEmptyCell(seat)) continue;
    const h = R.HOLES[id];
    const piece = svgCircle(h.px, h.py, PIECE_R, 'piece c' + seat, id);
    if (id === current) piece.classList.add('selected');
    piece.addEventListener('click', () => onHoleClick(view, id)); // 真实浏览器里 pointer-events:none 不会触发，兜底给测试用
    svg.appendChild(piece);
  }

  // 6) 合法落点提示圈（金色虚线圈）
  for (const to of hints.keys()) {
    const h = R.HOLES[to];
    if (!h) continue;
    const hint = svgCircle(h.px, h.py, HINT_R, 'hint', to);
    hint.addEventListener('click', () => onHoleClick(view, to)); // 同上：真实浏览器由 .hit 接管
    svg.appendChild(hint);
  }

  // 7) 121 个透明热区（最上层，占领点击）
  const myTurn = view.phase === 'play' && mySeat !== null && view.turn === mySeat;
  for (const h of R.HOLES) {
    const hit = svgCircle(h.px, h.py, HIT_R, 'hit', h.id);
    if (myTurn && board[h.id] === mySeat) hit.classList.add('mine');
    hit.addEventListener('click', () => onHoleClick(view, h.id));
    svg.appendChild(hit);
  }
}

/**
 * 只保留「跳」的后续落点（连跳不能接走一步）；
 * used 是本回合已经经过的孔，连跳规则不允许重复经过。
 */
function jumpContinuations(board, from, used) {
  const blocked = used || new Set([from]);
  const out = new Map();
  for (const [to, path] of R.reachable(board, from)) {
    if (R.isStep(path)) continue;
    if (path.slice(1).some((id) => blocked.has(id))) continue;
    out.set(to, path);
  }
  return out;
}

/** 提交当前连跳草稿 */
function finishChain() {
  if (!chain) return;
  const act = { type: 'move', from: chain.start, path: chain.path.slice() };
  chain = null;
  if (actionCb) actionCb(act);
}

/** 取消连跳草稿 */
function cancelChain(view, mySeat) {
  chain = null;
  selected = -1;
  reachable = new Map();
  renderBoard(view, mySeat);
  renderActions(view, mySeat);
}

/** 连跳草稿里继续点下一落点 */
function extendChain(view, mySeat, id) {
  const cur = chain.path[chain.path.length - 1];
  const cont = chain.reach.get(id).slice();
  const nextBoard = R.applyMove(chain.board, cur, cont).board;
  const path = chain.path.concat(cont.slice(1));
  const nextReach = jumpContinuations(nextBoard, id, new Set(path));
  if (nextReach.size > 0) {
    chain = { start: chain.start, path, board: nextBoard, reach: nextReach };
    renderBoard(view, mySeat);
    renderActions(view, mySeat);
    return;
  }
  const act = { type: 'move', from: chain.start, path };
  chain = null;
  if (actionCb) actionCb(act);
}

function onHoleClick(view, id) {
  const mySeat = mySeatOf(view);
  if (mySeat === null) {
    toast('观战中，只能看棋');
    return;
  }
  if (view.phase !== 'play') {
    toast('对局还没开始或已经结束');
    return;
  }
  if (view.turn !== mySeat) {
    toast('还没轮到你走棋');
    return;
  }

  // 连跳草稿中：点当前棋子 = 结束连跳；点金色落点 = 继续跳；点其他位置 = 取消
  if (chain) {
    const cur = chain.path[chain.path.length - 1];
    if (id === cur) {
      finishChain();
      return;
    }
    if (chain.reach.has(id)) {
      extendChain(view, mySeat, id);
      return;
    }
    if (!isEmptyCell(view.board[id]) && view.board[id] !== mySeat) {
      cancelChain(view, mySeat);
      toast('已取消连跳');
      return;
    }
    chain = null;
    selected = -1;
    reachable = new Map();
    renderBoard(view, mySeat);
    renderActions(view, mySeat);
    toast('已取消连跳');
    return;
  }

  const seat = view.board[id]; // null 或 0..5（0 是有效棋子！）
  if (seat === mySeat) {
    // 点自己的棋子：选中 / 取消选中 / 换一颗
    if (selected === id) {
      selected = -1;
      reachable = new Map();
    } else {
      selected = id;
      reachable = R.reachable(view.board, id);
    }
    renderBoard(view, mySeat);
    return;
  }
  if (selected >= 0 && reachable.has(id)) {
    const from = selected;
    const path = reachable.get(id).slice();
    // 规则：一手要么走一步，要么全是跳；可以一下一下跳，也可以直接点最远落点一次跳完
    const isJump = !R.isStep(path);
    const virtual = R.applyMove(view.board, from, path).board;
    const cont = isJump ? jumpContinuations(virtual, id, new Set(path)) : new Map();
    if (path.length === 2 && cont.size > 0) {
      // 这一下跳完还有得跳：进入逐下连跳模式，由「结束连跳」或下一个落点收尾
      chain = { start: from, path, board: virtual, reach: cont };
      selected = -1;
      reachable = new Map();
      renderBoard(view, mySeat);
      renderActions(view, mySeat);
      toast('可以继续连跳：点金色落点接着跳，或点「结束连跳」');
      return;
    }
    selected = -1;
    reachable = new Map();
    if (actionCb) actionCb({ type: 'move', from, path });
    return;
  }
  if (!isEmptyCell(seat)) {
    toast('那不是你的棋子');
    return;
  }
  // 点空格且不可达：取消选中
  if (selected >= 0) {
    selected = -1;
    reachable = new Map();
    renderBoard(view, mySeat);
  }
}

/** 棋谱：2-6 人，一行一手：序号 + 颜色点 + 名字 + notation */
function renderMoves(view) {
  const ol = $('move-list');
  if (!ol) return;
  ol.innerHTML = '';
  const moves = view.moves || [];
  if (!moves.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '红方先行，还没有走棋';
    ol.appendChild(li);
    return;
  }
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const li = document.createElement('li');
    if (i === moves.length - 1) li.className = 'newest';
    li.innerHTML =
      `<span class="no">${i + 1}.</span>` +
      `<span class="dot c${m.seat}"></span>` +
      `<span class="who">${escapeHtml(playerName(view, m.seat))}</span>` +
      `<span class="notation">${escapeHtml(m.notation)}</span>`;
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;
}

function renderOffers(view, mySeat) {
  const bar = $('offer-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const offers = view.offers || {};
  const n = playerCountOf(view);
  const need = Math.max(0, n - 1);

  const undo = Number.isInteger(offers.undo) ? offers.undo : null;
  const draw = offers.draw && Number.isInteger(offers.draw.by) ? offers.draw : null;
  const accepts = draw && Array.isArray(draw.accepts) ? draw.accepts : [];

  let text = '';
  let kind = null; // 'undo' | 'draw'：需要我回应时挂按钮
  if (undo !== null) {
    if (undo === mySeat) {
      text = '已发出悔棋请求，等待其他玩家同意…';
    } else {
      text = `${playerName(view, undo)} 请求悔棋`;
      if (mySeat !== null) kind = 'undo';
    }
  } else if (draw) {
    if (draw.by === mySeat) {
      text = `已发出求和请求，等待其他玩家同意（${accepts.length}/${need}）`;
    } else if (mySeat !== null && accepts.includes(mySeat)) {
      text = '你已同意求和，等待其他玩家…';
    } else {
      text = `${playerName(view, draw.by)} 请求求和` + (accepts.length ? `（已同意 ${accepts.length}/${need}）` : '');
      if (mySeat !== null) kind = 'draw';
    }
  }

  if (!text) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = text;
  bar.appendChild(txt);
  if (kind) {
    bar.appendChild(btn('同意', 'primary tiny', () => actionCb && actionCb({ type: kind + 'Reply', accept: true })));
    bar.appendChild(btn('拒绝', 'ghost tiny', () => actionCb && actionCb({ type: kind + 'Reply', accept: false })));
  }
}

function renderActions(view, mySeat) {
  const bar = $('actions');
  if (!bar) return;
  bar.innerHTML = '';

  // 连跳进行中：只给「结束连跳 / 取消」，避免中途误触其他操作
  if (chain && mySeat !== null && view.phase === 'play') {
    const ch = document.createElement('span');
    ch.className = 'status';
    ch.textContent = '连跳中：点金色落点接着跳，或点「结束连跳」';
    bar.appendChild(ch);
    const sp = document.createElement('span');
    sp.className = 'spacer';
    bar.appendChild(sp);
    bar.appendChild(btn('结束连跳', 'primary tiny', () => finishChain()));
    bar.appendChild(btn('取消', 'ghost tiny', () => cancelChain(view, mySeat)));
    return;
  }

  const status = document.createElement('span');
  if (view.phase === 'over') {
    status.className = 'wait';
    status.textContent = '本局结束';
  } else if (view.phase === 'lobby') {
    status.className = 'wait';
    status.textContent = '等待房主开始对局…';
  } else if (mySeat === null) {
    status.className = 'wait';
    status.textContent = '观战中';
  } else if (view.turn === mySeat) {
    status.className = 'status';
    status.textContent = `轮到你走棋（${R.SEAT_NAMES[mySeat]}方）`;
  } else {
    status.className = 'wait';
    status.textContent = `等待 ${playerName(view, view.turn)} 走棋…`;
  }
  bar.appendChild(status);

  if (mySeat === null || view.phase !== 'play') return;

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  bar.appendChild(spacer);

  const canUndo = view.canUndo !== undefined
    ? !!view.canUndo
    : (view.moves || []).some((m) => m.seat === mySeat);
  const undoBtn = btn('悔棋', 'ghost tiny', () => actionCb && actionCb({ type: 'undo' }));
  undoBtn.disabled = !canUndo;
  bar.appendChild(undoBtn);

  const off = view.offers || {};
  const pending = Number.isInteger(off.undo) || !!off.draw; // 0 号座位的悔棋请求也是有效值
  const drawBtn = btn('求和', 'ghost tiny', () => actionCb && actionCb({ type: 'draw' }));
  drawBtn.disabled = pending;
  bar.appendChild(drawBtn);

  const resignBtn = btn(resignArmed ? '确定认输' : '认输', 'ghost tiny danger', () => {
    if (!resignArmed) {
      resignArmed = true;
      resignBtn.textContent = '确定认输';
      clearTimeout(resignArmTimer);
      resignArmTimer = setTimeout(() => {
        resignArmed = false;
        resignBtn.textContent = '认输';
      }, 4000);
      return;
    }
    resignArmed = false;
    clearTimeout(resignArmTimer);
    if (actionCb) actionCb({ type: 'resign' });
  });
  bar.appendChild(resignBtn);
}

function renderQuick() {
  const box = $('quick');
  if (!box || quickReady) return;
  quickReady = true;
  for (const q of QUICK) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = q;
    b.addEventListener('click', () => chatCb && chatCb(q));
    box.appendChild(b);
  }
}

/* ---------------- 聊天 ---------------- */

const CHAT_KEEP = 60;

export function renderChat(list = [], me = '') {
  const log = $('chat-log');
  if (!log) return;
  log.innerHTML = '';
  const items = Array.isArray(list) ? list.slice(-CHAT_KEEP) : [];
  for (const m of items) {
    if (!m) continue;
    const div = document.createElement('div');
    if (m.kind === 'sys') {
      div.className = 'msg sys';
      div.textContent = m.text;
    } else {
      div.className = 'msg' + (m.name && m.name === me ? ' me' : '');
      div.innerHTML = `<span class="who">${escapeHtml(m.name || '')}</span>${escapeHtml(m.text || '')}`;
    }
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
}

/* ---------------- 结算 / 菜单浮层 ---------------- */

function renderResult(view, mySeat) {
  const ov = $('overlay');
  const panel = $('overlay-panel');
  if (!ov || !panel) return;
  const r = view.result || { winner: -1, reason: 'draw', text: '', plies: 0 };
  const winner = Number.isInteger(r.winner) ? r.winner : -1; // -1 = 没有胜者
  let title;
  let cls;
  if (winner >= 0) {
    if (mySeat !== null) {
      const win = winner === mySeat;
      title = win ? '你赢了！' : '你输了';
      cls = win ? 'wr' : 'wb';
    } else {
      title = `${playerName(view, winner)} 获胜`;
      cls = 'c' + winner;
    }
  } else {
    title = r.reason === 'draw' ? '和棋' : '对局结束';
    cls = 'wd';
  }
  panel.innerHTML =
    `<h2 class="${cls}">${title}</h2>` +
    `<p class="calc">${escapeHtml(r.text)} · 共 ${r.plies} 手</p>` +
    '<div class="ov-actions"></div>';
  const acts = panel.querySelector('.ov-actions');
  if (mySeat === null) {
    const s = document.createElement('span');
    s.className = 'wait';
    s.textContent = '观战结束';
    acts.appendChild(s);
  } else if (view._isHost) {
    acts.appendChild(btn('再来一局', 'primary', () => actionCb && actionCb({ type: 'restart' })));
  } else {
    const s = document.createElement('span');
    s.className = 'wait';
    s.textContent = '等待房主开新局…';
    acts.appendChild(s);
  }
  ov.classList.remove('hidden');
  ov.dataset.mode = 'result';
}

/** 菜单浮层（房号 / 角色说明 / 关闭 / 离开房间） */
export function showMenu({ code, role, onQuit } = {}) {
  const ov = $('overlay');
  const panel = $('overlay-panel');
  if (!ov || !panel) return;
  const roleText =
    role === 'host'
      ? '你是房主（红方先行），房主离开房间就散局了'
      : role === 'spectator'
        ? '你是观战，离开房间可以再输入房号回来'
        : '离开房间可以再输入房号回来';
  panel.innerHTML =
    `<h2 class="wd">房间 ${escapeHtml(code || '----')}</h2>` +
    `<p class="calc">${roleText}</p>` +
    '<div class="ov-actions"></div>';
  const acts = panel.querySelector('.ov-actions');
  acts.appendChild(btn('关闭', 'ghost', () => clearOverlay()));
  acts.appendChild(btn('离开房间', 'primary', () => {
    clearOverlay();
    if (onQuit) onQuit();
  }));
  ov.classList.remove('hidden');
  ov.dataset.mode = 'menu';
}

export function clearOverlay() {
  const ov = $('overlay');
  if (!ov) return;
  delete ov.dataset.mode;
  ov.classList.add('hidden');
}

/* ---------------- 侧栏切换 / 聊天绑定 ---------------- */

export function bindUI() {
  const tabMoves = $('tab-moves');
  const tabChat = $('tab-chat');
  const showTab = (name) => {
    if (tabMoves) tabMoves.classList.toggle('active', name === 'moves');
    if (tabChat) tabChat.classList.toggle('active', name === 'chat');
    const moves = $('move-list');
    const pane = $('chat-pane');
    if (moves) moves.classList.toggle('hidden', name !== 'moves');
    if (pane) pane.classList.toggle('hidden', name !== 'chat');
  };

  if (!uiBound) {
    uiBound = true;
    if (tabMoves) tabMoves.addEventListener('click', () => showTab('moves'));
    if (tabChat) tabChat.addEventListener('click', () => showTab('chat'));

    const form = $('chat-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('chat-input');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        if (chatCb) chatCb(text);
      });
    }
  }
  renderQuick();
}
