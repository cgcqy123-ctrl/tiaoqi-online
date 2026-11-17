// 中国跳棋界面渲染与交互（只负责 DOM，不含规则判定与网络）
// 数据源：game.view(seat) 生成的视图对象；用户动作通过 actionCb 交给 main.js 转发。

const V = new URL(import.meta.url).search; // 跟随 index.html 的 ?v= 做缓存穿透
const R = await import('./rules.js' + V);

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const QUICK = ['你好 👋', '开局吧', '这步跳得漂亮', '手下留情', '再来一局？', '稳住'];

// 棋盘几何：VIEW 已由 rules.js 算好（含留白），六角星是宽扁的
const RATIO = R.VIEW.w / R.VIEW.h;
// 半径用契约里的字面值（SVG 属性写成 0.30 / 0.4 / 0.46 / 0.52，方便测试直接比对）
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

/** 从视图里按座位号找玩家（视图里 players 固定 2 项且按下标排列，这里仍按 seat 找更稳） */
function playerOf(view, seat) {
  return (view.players || []).find((p) => p.seat === seat) || null;
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

/** 渐变定义（棋子高光 / 木色星盘）——纯 SVG 内置，不引用任何外部资源 */
function buildDefs() {
  const defs = svgEl('defs');
  const grad = (id, stops) => {
    const g = svgEl('radialGradient', { id, cx: '35%', cy: '30%', r: '78%' });
    for (const [offset, color] of stops) g.appendChild(svgEl('stop', { offset, 'stop-color': color }));
    defs.appendChild(g);
  };
  grad('piece-red', [['0%', '#ffb694'], ['45%', '#e0553d'], ['100%', '#8f241a']]);
  grad('piece-blue', [['0%', '#a8d8ff'], ['45%', '#3c7fd4'], ['100%', '#1a3c86']]);
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
} = {}) {
  showScreen('lobby');
  const codeEl = $('lobby-code');
  if (codeEl) codeEl.textContent = code || '----';

  const ul = $('seat-list');
  if (ul) {
    ul.innerHTML = '';
    for (const seat of [0, 1]) {
      const p = players[seat] || { name: '', connected: false };
      const li = document.createElement('li');
      const sideCls = seat === 0 ? 'red' : 'blue';
      li.className = 'seat-item ' + sideCls + (p.name ? ' filled' : '');
      li.innerHTML =
        `<span class="idx">${seat === 0 ? '红' : '蓝'}</span>` +
        `<span class="nm">${p.name ? escapeHtml(p.name) : '空位'}` +
        `${p.name && seat === youSeat ? '（你）' : ''}` +
        `${p.name && p.connected === false ? ' <i>离线</i>' : ''}</span>` +
        `<span class="tag">${seat === 0 ? '红方 · 先行' : '蓝方'}</span>`;
      ul.appendChild(li);
    }
  }

  const specNames = (spectators || []).filter(Boolean);
  const specEl = $('lobby-spec');
  if (specEl) specEl.textContent = specNames.length ? `观战：${specNames.join('、')}` : '第 3 位起自动成为观战';

  const startBtn = $('btn-start');
  if (startBtn) {
    startBtn.classList.toggle('hidden', !isHost);
    startBtn.disabled = !canStart;
    const filled = players.filter((p) => p && p.name).length;
    startBtn.textContent = canStart ? '开始对局' : `等待对手入座（${filled}/2）`;
  }

  const tipEl = $('lobby-tip');
  if (tipEl) {
    tipEl.textContent = tip || (isHost ? '把房号发给朋友，两人到齐后点「开始对局」' : '等待房主开始对局…');
  }
}

/* ---------------- 棋盘尺寸 ---------------- */

/** 用 #board-box 的宽高和星形宽高比，给 #board 设定合适尺寸（铺满可用空间） */
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
  boardSig = '';
  if (lastView) renderBoard(lastView);
}

/**
 * 渲染棋桌。view 由 game.view(seat) 得出，另外可带 _code / _isHost / _spectators。
 * actionCb 负责把动作发给房主（本地直接调用 / 远端走网络）。
 */
export function renderTable(view, cb) {
  actionCb = cb;
  const sig = (view.board ? view.board.join('') : '') + '#' + view.turn + '#' + view.phase;
  if (sig !== boardSig) {
    boardSig = sig;
    selected = -1;
    reachable = new Map();
  }
  lastView = view;
  showScreen('table');

  const codeEl = $('t-code');
  if (codeEl && view._code) codeEl.textContent = view._code;

  const p0 = playerOf(view, 0);
  const p1 = playerOf(view, 1);
  const roomEl = $('t-room');
  if (roomEl) roomEl.textContent = `${p0 ? p0.name : '红方'} vs ${p1 ? p1.name : '蓝方'}`;

  const specEl = $('side-spec');
  if (specEl) {
    const specs = view._spectators || [];
    specEl.textContent = specs.length ? `观战 ${specs.length}` : '';
  }

  renderPlayers(view);
  renderBoard(view);
  renderMoves(view);
  renderOffers(view);
  renderActions(view);
  renderQuick();

  const ov = $('overlay');
  if (view.phase === 'over' && view.result) {
    if (!ov || ov.dataset.mode !== 'menu') renderResult(view);
  } else if (!ov || ov.dataset.mode !== 'menu') {
    clearOverlay();
  }
  layoutBoard();
}

function renderPlayers(view) {
  const root = $('t-players');
  if (!root) return;
  root.innerHTML = '';
  const goals = view.goalCount || { r: 0, b: 0 };
  for (const p of view.players || []) {
    const chip = document.createElement('div');
    const active = view.phase === 'play' && view.turn === p.side;
    const me = view.mySide !== null && view.mySide === p.side;
    chip.className = 'player-chip' + (active ? ' active' : '') + (me ? ' me' : '');
    chip.innerHTML =
      `<span class="dot-side ${p.side}"></span>` +
      `<span class="nm">${escapeHtml(p.name)}</span>` +
      (p.connected === false ? '<i class="off">离线</i>' : '') +
      `<span class="goal">入营 ${goals[p.side] || 0}/10</span>`;
    root.appendChild(chip);
  }
}

/** 全量重建 #board-svg：星形底盘 → 营三角 → 孔 → 上一步标记 → 棋子 → 提示 → 热区 */
function renderBoard(view) {
  const svg = $('board-svg');
  if (!svg) return;
  svg.setAttribute('viewBox', `${R.VIEW.x} ${R.VIEW.y} ${R.VIEW.w} ${R.VIEW.h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  svg.appendChild(buildDefs());

  // 1) 两个大三角拼成六角星（木色底）
  for (const tri of R.BOARD_TRIANGLES) svg.appendChild(svgPolygon(tri, 'board-tri'));
  // 2) 两个营三角（下红上蓝）
  svg.appendChild(svgPolygon(R.HOME_TRIANGLES.r, 'home-tri home-red'));
  svg.appendChild(svgPolygon(R.HOME_TRIANGLES.b, 'home-tri home-blue'));
  // 3) 121 个孔
  for (const h of R.HOLES) svg.appendChild(svgCircle(h.px, h.py, HOLE_R, 'hole', h.id));
  // 4) 上一步路径标记（起点 / 中间落点 / 终点都标）
  if (view.lastMove && Array.isArray(view.lastMove.path)) {
    for (const id of view.lastMove.path) {
      const h = R.HOLES[id];
      if (h) svg.appendChild(svgCircle(h.px, h.py, LAST_R, 'last', id));
    }
  }
  // 5) 棋子（pointer-events: none，点击交给最上层的热区）
  for (let id = 0; id < view.board.length; id++) {
    const side = view.board[id];
    if (!side) continue;
    const h = R.HOLES[id];
    const piece = svgCircle(h.px, h.py, PIECE_R, 'piece ' + side, id);
    if (id === selected) piece.classList.add('selected');
    piece.addEventListener('click', () => onHoleClick(view, id)); // 真实浏览器里 pointer-events:none 不会触发，兜底给测试用
    svg.appendChild(piece);
  }
  // 6) 合法落点提示圈（金色虚线圈）
  for (const to of reachable.keys()) {
    const h = R.HOLES[to];
    if (!h) continue;
    const hint = svgCircle(h.px, h.py, HINT_R, 'hint', to);
    hint.addEventListener('click', () => onHoleClick(view, to)); // 同上：真实浏览器由 .hit 接管
    svg.appendChild(hint);
  }
  // 7) 121 个透明热区（最上层，占领点击）
  const myTurn = view.phase === 'play' && !!view.mySide && view.turn === view.mySide;
  for (const h of R.HOLES) {
    const hit = svgCircle(h.px, h.py, HIT_R, 'hit', h.id);
    if (myTurn && view.board[h.id] === view.mySide && h.id !== selected) hit.classList.add('mine');
    hit.addEventListener('click', () => onHoleClick(view, h.id));
    svg.appendChild(hit);
  }
}

function onHoleClick(view, id) {
  if (!view.mySide) {
    toast('观战中，只能看棋');
    return;
  }
  if (view.phase !== 'play') {
    toast('对局还没开始或已经结束');
    return;
  }
  if (view.turn !== view.mySide) {
    toast('还没轮到你走棋');
    return;
  }

  const side = view.board[id];
  if (side === view.mySide) {
    // 点自己的棋子：选中 / 取消选中 / 换一颗
    if (selected === id) {
      selected = -1;
      reachable = new Map();
    } else {
      selected = id;
      reachable = R.reachable(view.board, id);
    }
    renderBoard(view);
    return;
  }
  if (selected >= 0 && reachable.has(id)) {
    // 点可达落点：发动作
    const from = selected;
    const path = reachable.get(id).slice();
    selected = -1;
    reachable = new Map();
    if (actionCb) actionCb({ type: 'move', from, path });
    return;
  }
  if (side) {
    toast('那不是你的棋子');
    return;
  }
  // 点空格且不可达：取消选中
  if (selected >= 0) {
    selected = -1;
    reachable = new Map();
    renderBoard(view);
  }
}

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
  const newest = Math.floor((moves.length - 1) / 2);
  for (let i = 0; i < moves.length; i += 2) {
    const li = document.createElement('li');
    if (i / 2 === newest) li.className = 'newest';
    const red = moves[i];
    const blue = moves[i + 1];
    li.innerHTML =
      `<span class="no">${i / 2 + 1}.</span>` +
      `<span class="r">${red ? escapeHtml(red.notation) : ''}</span>` +
      `<span class="b">${blue ? escapeHtml(blue.notation) : ''}</span>`;
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;
}

function renderOffers(view) {
  const bar = $('offer-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const offers = view.offers || {};
  const undo = offers.undo === undefined ? null : offers.undo;
  const draw = offers.draw === undefined ? null : offers.draw;
  const mine = (seat) => seat !== null && seat !== undefined && seat === view.seat;
  let text = '';
  let kind = null;
  if (undo !== null && undo !== undefined) {
    text = mine(undo) ? '已发出悔棋请求，等待对方同意…' : `${(playerOf(view, undo) || { name: '对方' }).name} 请求悔棋`;
    kind = mine(undo) ? null : 'undo';
  } else if (draw !== null && draw !== undefined) {
    text = mine(draw) ? '已发出求和请求，等待对方同意…' : `${(playerOf(view, draw) || { name: '对方' }).name} 请求求和`;
    kind = mine(draw) ? null : 'draw';
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
  if (kind && view.mySide) {
    bar.appendChild(btn('同意', 'primary tiny', () => actionCb && actionCb({ type: kind + 'Reply', accept: true })));
    bar.appendChild(btn('拒绝', 'ghost tiny', () => actionCb && actionCb({ type: kind + 'Reply', accept: false })));
  }
}

function renderActions(view) {
  const bar = $('actions');
  if (!bar) return;
  bar.innerHTML = '';

  const status = document.createElement('span');
  if (view.phase === 'over') {
    status.className = 'wait';
    status.textContent = '本局结束';
  } else if (view.phase === 'lobby') {
    status.className = 'wait';
    status.textContent = '等待房主开始对局…';
  } else if (!view.mySide) {
    status.className = 'wait';
    status.textContent = '观战中';
  } else if (view.turn === view.mySide) {
    status.className = 'status';
    status.textContent = `轮到你走棋（${R.SIDE_NAME[view.mySide]}方）`;
  } else {
    status.className = 'wait';
    const foe = (view.players || []).find((p) => p.side === view.turn);
    status.textContent = `等待 ${foe ? foe.name : '对手'} 走棋…`;
  }
  bar.appendChild(status);

  if (!view.mySide || view.phase !== 'play') return;

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  bar.appendChild(spacer);

  const canUndo = view.canUndo !== undefined ? !!view.canUndo : (view.moves || []).length > 0;
  const undoBtn = btn('悔棋', 'ghost tiny', () => actionCb && actionCb({ type: 'undo' }));
  undoBtn.disabled = !canUndo;
  bar.appendChild(undoBtn);

  const pending = (view.offers || {}).undo != null || (view.offers || {}).draw != null;
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

function renderResult(view) {
  const ov = $('overlay');
  const panel = $('overlay-panel');
  if (!ov || !panel) return;
  const r = view.result;
  let title;
  let cls;
  if (!r.winner) {
    title = '和棋';
    cls = 'wd';
  } else if (view.mySide) {
    const win = r.winner === view.mySide;
    title = win ? '你赢了！' : '你输了';
    cls = win ? 'wr' : 'wb';
  } else {
    title = `${R.SIDE_NAME[r.winner]}方胜`;
    cls = r.winner === R.RED ? 'wr' : 'wb';
  }
  panel.innerHTML =
    `<h2 class="${cls}">${title}</h2>` +
    `<p class="calc">${escapeHtml(r.text)} · 共 ${r.plies} 手</p>` +
    '<div class="ov-actions"></div>';
  const acts = panel.querySelector('.ov-actions');
  if (!view.mySide) {
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
