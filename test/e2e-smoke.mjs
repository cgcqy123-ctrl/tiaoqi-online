// 端到端冒烟测试（2-6 人，需要 jsdom）：在 jsdom 里真跑 main.js，用假 Peer 模拟好友 + 观众
// 覆盖：首页选 3 人建房 → 乙/丙入座 → 大厅 3 座 → 开局 30 子 → 回合 0→1→2→0 走 12 手
//       → 第 4 人自动观战 → 多人悔棋（回退到请求方上一步之前）→ 求和被拒 → 聊天
//       → 多人认输（winner=-1）→ 非房主 restart 被拒 → 再来一局 → 掉线重连
//       → 新建 6 人局（5 位好友坐满 + 第 7 人观战 + 开局 60 子）
//       → GuestRoom 首条 hello 丢失后重发直测
// 运行：npm install && npm run test:e2e
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
  url: 'https://example.com/',
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.localStorage = dom.window.localStorage;

// jsdom 的 SVGElement 没有 click()，补一个（棋盘热区都是 SVG circle）
if (!dom.window.SVGElement.prototype.click) {
  dom.window.SVGElement.prototype.click = function () {
    this.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
}

/* ---------------- 假 PeerJS（同时支持 new Peer(id, opts) 和 new Peer(opts)） ---------------- */

const registry = new Map();
let connSeq = 0;

class FakeConn {
  constructor(remoteId) {
    this.id = 'c' + ++connSeq;
    this.peer = remoteId;
    this.open = false;
    this.h = {};
    this.remote = null;
    this.closed = false;
  }
  on(ev, cb) { (this.h[ev] = this.h[ev] || []).push(cb); return this; }
  emit(ev, arg) { for (const cb of this.h[ev] || []) cb(arg); }
  send(msg) {
    if (!this.open) throw new Error('conn is not open');
    const copy = JSON.parse(JSON.stringify(msg));
    const other = this.remote;
    if (other) setTimeout(() => other.emit('data', copy), 0);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
    const other = this.remote;
    if (other && !other.closed) setTimeout(() => other.emit('close'), 0);
  }
  _open() { this.open = true; this.emit('open'); }
}

class FakePeer {
  constructor(idOrOptions, maybeOptions) {
    let id;
    if (typeof idOrOptions === 'string') id = idOrOptions;
    this.id = id || 'auto-' + Math.random().toString(36).slice(2, 8);
    this.opts = (typeof idOrOptions === 'object' && idOrOptions) || maybeOptions || {};
    this.h = {};
    if (registry.has(this.id)) {
      setTimeout(() => this.emit('error', { type: 'unavailable-id' }), 0);
      return;
    }
    registry.set(this.id, this);
    setTimeout(() => this.emit('open', this.id), 0);
  }
  on(ev, cb) { (this.h[ev] = this.h[ev] || []).push(cb); return this; }
  emit(ev, arg) { for (const cb of this.h[ev] || []) cb(arg); }
  connect(remoteId) {
    const a = new FakeConn(remoteId);
    const target = registry.get(remoteId);
    if (!target) {
      setTimeout(() => this.emit('error', { type: 'peer-unavailable' }), 0);
      return a;
    }
    const b = new FakeConn(this.id);
    a.remote = b;
    b.remote = a;
    setTimeout(() => {
      target.emit('connection', b);
      b._open();
      a._open();
    }, 0);
    return a;
  }
  reconnect() { /* 无需实现 */ }
  destroy() { registry.delete(this.id); }
}

// 必须在 import main.js 之前把假的 Peer 挂上去
global.Peer = FakePeer;
dom.window.Peer = FakePeer;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** 轮询等待条件成立（Windows 下定时器粒度粗，固定 tick 容易偶发失败） */
async function waitFor(fn, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    let v = false;
    try { v = !!fn(); } catch (_) { v = false; }
    if (v) return true;
    await tick(5);
  }
  try { return !!fn(); } catch (_) { return false; }
}
const PROBLEMS = [];
const ok = (c, m) => { if (!c) PROBLEMS.push(m); };
const $ = (id) => document.getElementById(id);
const findBtn = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text)) || null;
const svgAll = (s) => document.querySelectorAll('#board-svg ' + s);
const clickHit = (id) => {
  const el = document.querySelector('#board-svg circle.hit[data-id="' + id + '"]');
  ok(!!el, '热区存在：' + id);
  if (el) el.click();
};
const seatOfDot = (dot) => {
  if (!dot) return null;
  const cls = [...dot.classList].find((c) => /^c\d$/.test(c));
  return cls ? Number(cls.slice(1)) : null;
};
/** 固定种子伪随机，保证走子脚本可复现 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(2026);

/* ---------------- 载入 main.js / rules / net ---------------- */

await import(url('js/main.js'));
const R = await import(url('js/rules.js'));
const net = await import(url('js/net.js'));
await tick(10);
ok(!$('scr-home').classList.contains('hidden'), '启动后停在首页');

/* ---------------- 首页人数选择器 ---------------- */

const countBtns = document.querySelectorAll('#count-pick button[data-n]');
ok(countBtns.length === 5, '首页人数选择器 5 个按钮，实际 ' + countBtns.length);
ok(document.querySelector('#count-pick button[data-n="2"]').classList.contains('on'), '默认选中 2 人');
document.querySelector('#count-pick button[data-n="3"]').click();
ok(document.querySelector('#count-pick button[data-n="3"]').classList.contains('on'), '点 3 人后 3 人按钮高亮');
ok(!document.querySelector('#count-pick button[data-n="2"]').classList.contains('on'), '2 人按钮取消高亮');

/* ---------------- 房主建 3 人房 ---------------- */

$('in-name').value = '甲';
$('btn-create').click();
await waitFor(() => !$('scr-lobby').classList.contains('hidden'));
let code = $('lobby-code').textContent.trim();
const code3p = code;
ok(/^[A-Z0-9]{4}$/.test(code), '房号是 4 位，实际：' + code);
let hostId = 'tiaoqi-' + code.toLowerCase();
ok(registry.has(hostId), '房主信令 id 带 tiaoqi- 前缀：' + hostId);
ok($('btn-start').disabled === true, '只有 1 人时不能开始');
ok(/3 人局/.test($('chat-log').textContent), '建房系统消息带人数');
ok(document.querySelectorAll('#seat-list li.seat-item').length === 3, '大厅 3 个玩家座位，实际 ' + document.querySelectorAll('#seat-list li.seat-item').length);
ok($('btn-start').textContent === '等待玩家入座 (1/3)', '开始按钮进度 1/3，实际：' + $('btn-start').textContent);

/* ---------------- 好友加入 ---------------- */

const boxes = []; // boxes[seat] = 远端 box（座位 1..N-1）
function joinAs(name) {
  const peer = new FakePeer();
  const conn = peer.connect(hostId);
  const box = { name, peer, conn, seat: null, spectator: false, states: 0, view: null, toasts: [], chats: [], lobby: null, full: false };
  conn.on('data', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'joined') {
      box.seat = msg.seat;
      box.spectator = !!msg.spectator;
      box.camp = msg.camp;
      box.playerCount = msg.playerCount;
    } else if (msg.t === 'state') {
      box.states++;
      box.view = msg.view;
    } else if (msg.t === 'lobby') {
      box.lobby = msg;
    } else if (msg.t === 'toast') {
      box.toasts.push(msg.msg);
    } else if (msg.t === 'chat') {
      box.chats.push(msg.msg);
    } else if (msg.t === 'full') {
      box.full = true;
    }
  });
  conn.on('open', () => conn.send({ t: 'hello', name }));
  return box;
}
function allGuestViews(plies) {
  return boxes.every((b) => b && b.view && b.view.moves.length === plies);
}

const foeB = joinAs('乙');
await waitFor(() => foeB.seat === 1, 3000);
const foeC = joinAs('丙');
await waitFor(() => foeC.seat === 2 && $('btn-start').disabled === false, 3000);
boxes[1] = foeB;
boxes[2] = foeC;
ok(foeB.seat === 1 && foeC.seat === 2, '乙/丙 分别坐 1/2 号位，实际 ' + foeB.seat + '/' + foeC.seat);
ok(foeB.spectator === false && foeC.spectator === false, '两位好友都是玩家');
ok(foeB.camp === R.campsForCount(3)[1] && foeC.camp === R.campsForCount(3)[2], 'joined 带自己的营下标');
ok(foeB.lobby && foeB.lobby.playerCount === 3 && foeB.lobby.players.length === 3, '好友收到 3 人大厅名单');
ok(foeB.lobby && foeB.lobby.youSeat === 1 && foeC.lobby.youSeat === 2, '好友知道自己的座位');
ok(document.querySelectorAll('#seat-list .seat-item.filled').length === 3, '大厅 3 个座位都有名字');
ok($('btn-start').textContent === '开始对局' && $('btn-start').disabled === false, '3 人到齐可以开始');
ok(/人齐了/.test($('lobby-tip').textContent), '人齐 tip');

/* ---------------- 开局：30 子 / 6 营 / 3 个目标环 ---------------- */

function hostBoard() {
  const b = new Array(R.SIZE).fill(null);
  for (const el of svgAll('circle.piece')) {
    const id = Number(el.getAttribute('data-id'));
    b[id] = seatOfDot(el);
  }
  return b;
}
function hostTurn() {
  return seatOfDot(document.querySelector('#t-players .player-chip.active .dot-side'));
}
function allMoves(board, seat) {
  const out = [];
  for (let i = 0; i < R.SIZE; i++) {
    if (board[i] !== seat) continue;
    for (const m of R.legalMoves(board, i)) out.push({ from: i, to: m.to, path: m.path });
  }
  return out;
}
function pickMove(board, seat) {
  const ms = allMoves(board, seat);
  if (!ms.length) return null;
  return ms[Math.floor(rand() * ms.length)];
}
function hostPlay(move) {
  clickHit(move.from);
  ok(svgAll('circle.hint').length > 0, '房主端点自己棋子后出现提示圈');
  ok(svgAll('circle.piece.selected').length === 1, '房主端选中的棋子有 selected');
  clickHit(move.to);
  // v3 连跳逐下交互：单次跳且还能继续跳时会进入草稿（不立刻发动作），点「结束连跳」提交
  const finishChain = findBtn($('actions'), '结束连跳');
  if (finishChain) finishChain.click();
  ok(svgAll('circle.hint').length === 0, '房主端提交后提示圈消失');
}

$('btn-start').click();
await waitFor(() => foeB.view && foeB.view.phase === 'play' && foeC.view && foeC.view.phase === 'play', 3000);
ok(!$('scr-table').classList.contains('hidden'), '开局后进入棋桌');
ok(svgAll('circle.hole').length === 121, '121 个 circle.hole');
ok(svgAll('circle.hit').length === 121, '121 个 circle.hit');
ok(svgAll('circle.piece').length === 30, '3 人局 30 颗棋子，实际 ' + svgAll('circle.piece').length);
for (let s = 0; s < 3; s++) ok(svgAll('circle.piece.c' + s).length === 10, '座位 ' + s + ' 有 10 颗 c' + s + ' 棋子');
ok(svgAll('polygon.home-tri').length === 6, '固定 6 个营三角');
ok(svgAll('polygon.home-tri.owner').length === 3, '3 个有主人的营');
ok(svgAll('polygon.home-ring').length === 3, '3 个目标营虚线环');
const expectViewBox = [R.VIEW.x, R.VIEW.y, R.VIEW.w, R.VIEW.h].join(' ');
ok($('board-svg').getAttribute('viewBox') === expectViewBox, 'viewBox = R.VIEW');
ok($('t-room').textContent === '3 人局 · 甲 vs 乙 vs 丙', '对阵显示，实际：' + $('t-room').textContent);
ok(/轮到你走棋（红方）/.test($('actions').textContent), '房主轮到走棋');
ok(/红方先行，还没有走棋/.test($('move-list').textContent), '空棋谱文案');
ok([...document.querySelectorAll('#t-players .goal')].map((x) => x.textContent).join('|') === '入营 0/10|入营 0/10|入营 0/10', '开局入营 0/10');
ok(foeB.view.count === 3 && foeC.view.count === 3, '好友视图 count=3');
ok(JSON.stringify(foeB.view.camps) === JSON.stringify(R.campsForCount(3)), '好友视图 camps 正确');
ok(foeB.view.turn === 0 && foeB.view.seat === 1, '好友视图回合/座位正确');

/* ---------------- 回合 0→1→2→0 走 12 手（房主点 UI、好友发协议） ---------------- */

async function playPlies(fromPlies, toPlies) {
  for (let plies = fromPlies; plies < toPlies; plies++) {
    const seat = plies % 3;
    await waitFor(() => hostTurn() === seat);
    if (seat === 0) {
      const move = pickMove(hostBoard(), 0);
      ok(!!move, '房主总能找到红方合法走法');
      if (!move) return;
      hostPlay(move);
    } else {
      const box = boxes[seat];
      await waitFor(() => box.view && box.view.turn === seat);
      const move = pickMove(box.view.board, seat);
      ok(!!move, '座位 ' + seat + ' 总能找到合法走法');
      if (!move) return;
      box.conn.send({ t: 'action', a: { type: 'move', from: move.from, path: move.path } });
    }
    await waitFor(() => allGuestViews(plies + 1), 3000);
    for (let s = 1; s <= 2; s++) {
      ok(boxes[s].view && boxes[s].view.moves.length === plies + 1, '第 ' + (plies + 1) + ' 手后座位 ' + s + ' 收到状态，实际 ' + (boxes[s].view && boxes[s].view.moves.length));
    }
    // 房主端与好友视图保持一致
    ok(hostBoard().join(',') === foeB.view.board.join(','), '第 ' + (plies + 1) + ' 手后房主 DOM 棋盘与好友视图一致');
    ok(svgAll('circle.piece').length === 30, '第 ' + (plies + 1) + ' 手后棋子仍 30 颗');
    ok(svgAll('circle.last').length === foeB.view.lastMove.path.length, 'last 标记数 = 最后路径长度');
    ok(document.querySelectorAll('#move-list li').length === plies + 1, '棋谱一行一手，共 ' + (plies + 1) + ' 行');
  }
}

await playPlies(0, 9);
ok(foeB.view.moves.length === 9 && foeC.view.moves.length === 9, '3 人各走 3 手，共 9 手');
ok(hostTurn() === 0, '9 手后轮到房间座位 0');
ok(/轮到你走棋（红方）/.test($('actions').textContent), '9 手后房主回合');
const lastLi = document.querySelectorAll('#move-list li')[8];
ok(!!lastLi.querySelector('.dot.c2') && lastLi.querySelector('.who').textContent === '丙', '第 9 手棋谱行显示丙的颜色点与名字');

/* ---------------- 第 4 人自动观战 ---------------- */

const spec = joinAs('观众丁');
await waitFor(() => spec.seat !== null && spec.view, 3000);
ok(spec.spectator === true, '第 4 人自动成为观众');
ok(spec.seat === 3, '3 人局观众座位号 = 3，实际 ' + spec.seat);
ok(spec.view.seat === -1 && spec.view.spectator === true, '观众收到观战视图');
ok(spec.view.count === 3, '观众视图 count=3');
await waitFor(() => $('side-spec').textContent === '观战 1');
ok($('side-spec').textContent === '观战 1', '房主端显示观战人数，实际：' + $('side-spec').textContent);

// 观众加入后再走 3 手（10..12）
await playPlies(9, 12);
await waitFor(() => spec.view && spec.view.moves.length === 12);
ok(spec.view.moves.length === 12, '观众也同步到 12 手，实际 ' + spec.view.moves.length);
ok(spec.states >= 4, '观众持续收到状态，实际 ' + spec.states);
ok(hostTurn() === 0, '12 手后轮到座位 0');

/* ---------------- 多人悔棋：回退到请求方上一步之前（退 3 手） ---------------- */

const undoBtn = findBtn($('actions'), '悔棋');
ok(undoBtn && !undoBtn.disabled, '轮到自己时可以点悔棋');
if (undoBtn) undoBtn.click();
await waitFor(() => foeB.view && foeB.view.offers.undo === 0);
ok(foeB.view.offers.undo === 0, '好友收到座位 0 的悔棋请求');
ok(/等待其他玩家同意/.test($('offer-bar').textContent), '房主端显示等待其他玩家同意，实际：' + $('offer-bar').textContent);
foeB.conn.send({ t: 'action', a: { type: 'undoReply', accept: true } });
await waitFor(() => foeB.view && foeB.view.moves.length === 9 && spec.view && spec.view.moves.length === 9);
ok(foeB.view.moves.length === 9, '多人悔棋回退 3 手：12 → ' + foeB.view.moves.length);
ok(document.querySelectorAll('#move-list li').length === 9, '悔棋后棋谱 9 行');
ok(svgAll('circle.piece').length === 30, '悔棋后棋子仍 30 颗');
ok(svgAll('circle.last').length === foeB.view.lastMove.path.length, '悔棋后 last 标记跟着回退');
ok(/回退 3 手/.test($('chat-log').textContent), '悔棋系统消息记录回退手数');
ok($('offer-bar').classList.contains('hidden'), '悔棋完成后请求条消失');

/* ---------------- 求和被拒 ---------------- */

foeC.conn.send({ t: 'action', a: { type: 'draw' } });
await waitFor(() => foeB.view && foeB.view.offers.draw && foeB.view.offers.draw.by === 2 && !$('offer-bar').classList.contains('hidden'));
ok(foeB.view.offers.draw && foeB.view.offers.draw.by === 2, '房主收到座位 2 的求和请求');
ok(Array.isArray(foeB.view.offers.draw.accepts) && foeB.view.offers.draw.accepts.length === 0, '求和请求的 accepts 是空数组');
ok(/丙 请求求和/.test($('offer-bar').textContent), '求和请求条文案，实际：' + $('offer-bar').textContent);
const rejectDraw = findBtn($('offer-bar'), '拒绝');
ok(!!rejectDraw, '有拒绝按钮');
if (rejectDraw) rejectDraw.click();
await waitFor(() => foeB.view && foeB.view.offers.draw === null && foeB.view.phase === 'play');
ok(foeB.view.offers.draw === null, '拒绝后求和请求消失');
ok(foeB.view.phase === 'play', '拒绝求和后对局继续');
ok($('offer-bar').classList.contains('hidden'), '拒绝后请求条隐藏');

/* ---------------- 聊天 ---------------- */

foeB.conn.send({ t: 'chat', text: '这步跳得漂亮' });
await waitFor(() => /这步跳得漂亮/.test($('chat-log').textContent));
ok(/这步跳得漂亮/.test($('chat-log').textContent), '房主能看到好友的聊天');
await waitFor(() => foeB.chats.some((m) => m && m.text === '这步跳得漂亮'));
ok(foeB.chats.some((m) => m && m.text === '这步跳得漂亮'), '好友能看到自己发出的消息（房主回显）');
$('chat-input').value = '开跳！';
$('chat-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
await waitFor(() => foeB.chats.some((m) => m && m.text === '开跳！') && foeC.chats.some((m) => m && m.text === '开跳！'));
ok(foeB.chats.some((m) => m && m.text === '开跳！') && foeC.chats.some((m) => m && m.text === '开跳！'), '两位好友都收到房主聊天');
ok(/开跳！/.test($('chat-log').textContent), '房主聊天本地显示');

/* ---------------- 多人认输（winner=-1）→ 非房主 restart 被拒 → 再来一局 ---------------- */

let resignBtn = findBtn($('actions'), '认输');
ok(!!resignBtn, '有认输按钮');
if (resignBtn) resignBtn.click();
await tick(5);
resignBtn = findBtn($('actions'), '确定认输');
ok(!!resignBtn, '认输需要二次确认');
if (resignBtn) resignBtn.click();
await waitFor(() => foeB.view && foeB.view.phase === 'over' && foeC.view && foeC.view.phase === 'over' && spec.view && spec.view.phase === 'over');
ok(!$('overlay').classList.contains('hidden'), '结束后弹出结算浮层');
ok($('overlay').dataset.mode === 'result', '结算浮层 mode=result');
ok(/对局结束/.test($('overlay-panel').textContent), '多人认输标题「对局结束」，实际：' + $('overlay-panel').textContent);
ok(/甲 认输，本局结束/.test($('overlay-panel').textContent), '结算副标题含认输者');
ok(foeB.view.result && foeB.view.result.winner === -1, '好友收到 winner=-1（无胜者），实际 ' + (foeB.view.result && foeB.view.result.winner));
ok(foeB.view.result && foeB.view.result.reason === 'resign' && foeB.view.result.resigned === 0, '好友收到认输结果');
ok(spec.view.phase === 'over', '观众也收到结束状态');

foeB.conn.send({ t: 'action', a: { type: 'restart' } });
await waitFor(() => foeB.toasts.some((m) => /只有房主能开新局/.test(String(m || ''))));
ok(foeB.toasts.some((m) => /只有房主能开新局/.test(String(m || ''))), '非房主 restart 被拒绝');

const again = findBtn($('overlay-panel'), '再来一局');
ok(!!again, '房主有「再来一局」');
if (again) again.click();
await waitFor(() => foeB.view && foeB.view.phase === 'play' && foeB.view.moves.length === 0 && foeC.view.phase === 'play');
ok(foeB.view.phase === 'play' && foeB.view.moves.length === 0, '再来一局后好友回到对局');
ok(svgAll('circle.piece').length === 30, '新一局 30 颗棋子');
ok(svgAll('circle.last').length === 0, '新一局没有 last 标记');
ok($('overlay').classList.contains('hidden'), '再来一局后关闭结算浮层');
ok(/新的一局开始，红方先行/.test($('chat-log').textContent), '再来一局系统消息');

/* ---------------- 掉线重连（座位 2） ---------------- */

foeC.conn.close();
await waitFor(() => document.querySelectorAll('#t-players .player-chip .off').length > 0);
ok(document.querySelectorAll('#t-players .player-chip .off').length === 1, '掉线后房主端显示离线标记');
ok(/掉线/.test($('chat-log').textContent), '掉线系统消息');
const foeCBack = joinAs('丙');
await waitFor(() => foeCBack.seat === 2 && foeCBack.view && foeCBack.view.phase === 'play', 3000);
ok(foeCBack.seat === 2, '同名重连回到 2 号位，实际 ' + foeCBack.seat);
ok(document.querySelectorAll('#t-players .player-chip .off').length === 0, '重连后离线标记消失');
boxes[2] = foeCBack;

/* ---------------- 新建 6 人局：5 位好友坐满 + 第 7 人观战 + 60 子 ---------------- */

$('btn-leave').click();
await waitFor(() => !$('scr-home').classList.contains('hidden'));
ok(!$('scr-home').classList.contains('hidden'), '离开房间回到首页');
document.querySelector('#count-pick button[data-n="6"]').click();
ok(document.querySelector('#count-pick button[data-n="6"]').classList.contains('on'), '选 6 人局');
$('in-name').value = '甲';
$('btn-create').click();
await waitFor(() => !$('scr-lobby').classList.contains('hidden') && document.querySelectorAll('#seat-list li.seat-item').length === 6);
code = $('lobby-code').textContent.trim();
hostId = 'tiaoqi-' + code.toLowerCase();
ok(registry.has(hostId), '6 人房信令 id 已注册');
ok(document.querySelectorAll('#seat-list li.seat-item').length === 6, '6 人局大厅 6 个座位，实际 ' + document.querySelectorAll('#seat-list li.seat-item').length);
ok($('btn-start').textContent === '等待玩家入座 (1/6)', '6 人局进度 1/6，实际：' + $('btn-start').textContent);

const sixBoxes = [];
for (let seat = 1; seat <= 5; seat++) {
  const b = joinAs('F' + seat);
  sixBoxes[seat] = b;
  await waitFor(() => b.seat === seat, 3000);
  ok(b.seat === seat, 'F' + seat + ' 坐 ' + seat + ' 号位，实际 ' + b.seat);
}
await waitFor(() => $('btn-start').disabled === false);
ok(document.querySelectorAll('#seat-list .seat-item.filled').length === 6, '6 人局座位坐满');
ok($('btn-start').textContent === '开始对局', '6 人坐满可以开始');
$('btn-start').click();
await waitFor(() => sixBoxes[5] && sixBoxes[5].view && sixBoxes[5].view.phase === 'play', 3000);
ok(!$('scr-table').classList.contains('hidden'), '6 人局开局进入棋桌');
ok(svgAll('circle.piece').length === 60, '6 人局 60 颗棋子，实际 ' + svgAll('circle.piece').length);
for (let s = 0; s < 6; s++) ok(svgAll('circle.piece.c' + s).length === 10, '6 人局座位 ' + s + ' 有 10 颗棋子');
ok(svgAll('polygon.home-tri.owner').length === 6, '6 个营都有主人');
ok(svgAll('polygon.home-ring').length === 6, '6 个目标营虚线环');
ok(document.querySelectorAll('#t-players .player-chip').length === 6, '6 个玩家 chip');
ok(/6 人局/.test($('t-room').textContent), '6 人局对阵显示，实际：' + $('t-room').textContent);
const spec6 = joinAs('围观者');
await waitFor(() => spec6.seat !== null && spec6.view, 3000);
ok(spec6.spectator === true, '第 7 人自动成为观众');
ok(spec6.seat >= 6, '6 人局观众座位号 >= 6，实际 ' + spec6.seat);
await waitFor(() => $('side-spec').textContent === '观战 1');
ok($('side-spec').textContent === '观战 1', '6 人局房主端显示观战 1');
ok(spec6.view.count === 6 && spec6.view.spectator === true, '6 人局观众视图 count=6');

// 观战席满员拒绝：2-6 人局最多 6 个观战位（观战席 6 个也满后第 13 人被拒绝）
for (let i = 1; i <= 5; i++) joinAs('围观' + i);
await waitFor(() => $('side-spec').textContent === '观战 6', 4000);
ok($('side-spec').textContent === '观战 6', '6 人局观战席已满 6 人，实际：' + $('side-spec').textContent);
const extra = joinAs('多出来的');
await waitFor(() => extra.full === true, 3000);
ok(extra.full === true, '第 13 个人被拒绝（6 玩家 + 6 观战已满）');

/* ---------------- GuestRoom 首条 hello 丢失后重发直测 ---------------- */

const testHost = new FakePeer('tiaoqi-test');
let helloCount = 0;
let swallowed = false;
testHost.on('connection', (conn) => {
  conn.on('data', (msg) => {
    if (!msg || msg.t !== 'hello') return;
    helloCount++;
    if (!swallowed) { // 模拟 Safari 丢掉数据通道刚建立时的第一条消息
      swallowed = true;
      return;
    }
    conn.send({ t: 'joined', seat: 1, code: 'TEST', spectator: false, playerCount: 3, camp: 2 });
  });
});
const received = [];
const fails = [];
const guest = new net.GuestRoom({
  onMessage: (msg) => received.push(msg),
  onFail: (m) => fails.push(m),
  onError: (m) => fails.push(m),
});
let joinErr = null;
try {
  await guest.join('test', '乙');
} catch (e) {
  joinErr = e;
}
ok(!joinErr, 'GuestRoom 能连上假房主，实际错误：' + (joinErr && joinErr.message));
await waitFor(() => received.some((m) => m && m.t === 'joined'), 4000);
ok(helloCount >= 2, '首条 hello 丢失后会重发，实际 hello 次数：' + helloCount);
ok(received.some((m) => m && m.t === 'joined'), '重发 hello 后收到 joined');
ok(guest.handshakeDone === true, '收到房主消息后握手完成标记为 true');
ok(guest.helloRetry === null, '握手成功后停止 hello 重发定时器');
guest.close();

/* ---------------- 汇总 ---------------- */

if (PROBLEMS.length) {
  console.error('❌ 端到端测试失败：\n - ' + PROBLEMS.join('\n - '));
  process.exit(1);
}
console.log(
  '✅ 端到端通过（3 人局）：房号 ' + code3p + '｜乙/丙入座｜30 子｜回合 0→1→2→0 走 12 手｜第 4 人观战｜悔棋退 3 手｜求和拒绝｜聊天｜多人认输 winner=-1｜非房主 restart 被拒｜再来一局｜掉线重连；另测 6 人局 60 子 + 第 7 人观战 + 观战满员拒绝 + hello 重发'
);
process.exit(0);
