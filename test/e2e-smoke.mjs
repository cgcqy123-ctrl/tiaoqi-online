// 端到端冒烟测试（需要 jsdom）：在 jsdom 里真跑 main.js，用假 Peer 模拟好友 + 观众
// 覆盖：建房 → 好友入座 → 大厅同步 → 开局 → 双方走 12 手 → 悔棋 → 求和拒绝 → 聊天
//       → 观众 → 认输 → 结算 → 再来一局（非房主 restart 被拒）→ 掉线重连 → 满员拒绝
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
async function waitFor(fn, ms = 2500) {
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
const findBtn = (root, text) =>
  [...root.querySelectorAll('button')].find((x) => x.textContent.includes(text)) || null;
const svgAll = (s) => document.querySelectorAll('#board-svg ' + s);
const clickHit = (id) => {
  const el = document.querySelector('#board-svg circle.hit[data-id="' + id + '"]');
  ok(!!el, '热区存在：' + id);
  if (el) el.click();
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

/* ---------------- 载入 main.js / rules ---------------- */

await import(url('js/main.js'));
const R = await import(url('js/rules.js'));
const net = await import(url('js/net.js'));
await tick(10);
ok(!$('scr-home').classList.contains('hidden'), '启动后停在首页');

/* ---------------- 房主建房 ---------------- */

$('in-name').value = '甲';
$('btn-create').click();
await waitFor(() => !$('scr-lobby').classList.contains('hidden'));
const code = $('lobby-code').textContent.trim();
ok(/^[A-Z0-9]{4}$/.test(code), '房号是 4 位，实际：' + code);
const hostId = 'tiaoqi-' + code.toLowerCase();
ok(registry.has(hostId), '房主信令 id 带 tiaoqi- 前缀：' + hostId);
ok($('btn-start').disabled === true, '只有 1 人时不能开始');
ok(/房间 /.test($('chat-log').textContent), '建房系统消息已显示');

/* ---------------- 好友加入 ---------------- */

function joinAs(name) {
  const peer = new FakePeer();
  const conn = peer.connect(hostId);
  const box = { name, peer, conn, seat: null, spectator: false, states: 0, view: null, toasts: [], chats: [], lobby: null, full: false };
  conn.on('data', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'joined') {
      box.seat = msg.seat;
      box.spectator = !!msg.spectator;
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

const foe = joinAs('乙');
await waitFor(() => foe.seat === 1 && $('btn-start').disabled === false, 2500);
ok(foe.seat === 1, '乙 应该坐 1 号位（蓝方），实际 ' + foe.seat);
ok(foe.spectator === false, '乙 是玩家不是观众');
ok(foe.lobby && foe.lobby.players[0].name === '甲' && foe.lobby.players[1].name === '乙', '好友收到大厅名单（房主/对手）');
ok(foe.lobby && foe.lobby.youSeat === 1, '好友知道自己的座位');
ok(document.querySelectorAll('#seat-list .seat-item.filled').length === 2, '大厅显示两个座位都有名字');
const lobbySeats = document.querySelectorAll('#seat-list .seat-item');
ok(lobbySeats[0].classList.contains('red') && /甲/.test(lobbySeats[0].textContent), '大厅 0 号位是红方甲');
ok(lobbySeats[1].classList.contains('blue') && /乙/.test(lobbySeats[1].textContent), '大厅 1 号位是蓝方乙');
ok(/甲/.test($('t-room').textContent) === false, '还没开局棋桌不显示对阵');

/* ---------------- 开局 ---------------- */

$('btn-start').click();
await waitFor(() => foe.view && foe.view.phase === 'play');
ok(!$('scr-table').classList.contains('hidden'), '开局后进入棋桌');
ok(svgAll('circle.hole').length === 121, '121 个 circle.hole，实际 ' + svgAll('circle.hole').length);
ok(svgAll('circle.hit').length === 121, '121 个 circle.hit，实际 ' + svgAll('circle.hit').length);
ok(svgAll('circle.piece').length === 20, '20 颗棋子，实际 ' + svgAll('circle.piece').length);
ok(svgAll('circle.piece.r').length === 10, '红方 10 颗');
ok(svgAll('circle.piece.b').length === 10, '蓝方 10 颗');
ok(svgAll('polygon.board-tri').length === 2, '2 个棋盘大三角');
ok(svgAll('polygon.home-tri').length === 2, '2 个营三角');
const expectViewBox = [R.VIEW.x, R.VIEW.y, R.VIEW.w, R.VIEW.h].join(' ');
ok($('board-svg').getAttribute('viewBox') === expectViewBox, 'viewBox = R.VIEW');
ok($('t-room').textContent === '甲 vs 乙', '对阵显示，实际：' + $('t-room').textContent);
ok(/轮到你走棋（红方）/.test($('actions').textContent), '房主轮到走棋，实际：' + $('actions').textContent);
ok(/红方先行，还没有走棋/.test($('move-list').textContent), '空棋谱文案');
ok(svgAll('circle.last').length === 0, '开局没有 last 标记');
ok([...document.querySelectorAll('#t-players .goal')].map((x) => x.textContent).join('|') === '入营 0/10|入营 0/10', '双方入营 0/10');
ok(foe.view.mySide === 'b', '好友执蓝');
ok(foe.view.turn === 'r', '红方先行');

/* ---------------- 双方走 12 手 ---------------- */

function hostBoard() {
  const b = new Array(R.SIZE).fill(null);
  for (const el of svgAll('circle.piece')) {
    b[Number(el.getAttribute('data-id'))] = el.classList.contains('r') ? 'r' : 'b';
  }
  return b;
}
function hostTurn() {
  const dot = document.querySelector('#t-players .player-chip.active .dot-side');
  if (!dot) return null;
  return dot.classList.contains('r') ? 'r' : 'b';
}
function allMoves(board, side) {
  const out = [];
  for (let i = 0; i < R.SIZE; i++) {
    if (board[i] !== side) continue;
    for (const m of R.legalMoves(board, i)) out.push({ from: i, to: m.to, path: m.path });
  }
  return out;
}
function pickRandomMove(board, side) {
  const ms = allMoves(board, side);
  if (!ms.length) return null;
  return ms[Math.floor(rand() * ms.length)];
}
/** 房主通过点 UI 走一步：点自己棋子 → 出现提示 → 点落点 */
function hostPlay(move) {
  clickHit(move.from);
  ok(svgAll('circle.hint').length > 0, '点自己棋子后出现提示圈');
  ok(svgAll('circle.piece.selected').length === 1, '选中的棋子有 selected');
  clickHit(move.to);
  ok(svgAll('circle.hint').length === 0, '落子后提示圈消失');
}

let plies = 0;
for (let i = 0; i < 6; i++) {
  await waitFor(() => hostTurn() === 'r');
  const redMove = pickRandomMove(hostBoard(), 'r');
  ok(!!redMove, '房主总能找到红方合法走法');
  if (!redMove) break;
  hostPlay(redMove);
  await waitFor(() => foe.view && foe.view.moves.length === 2 * i + 1);
  ok(foe.view && foe.view.moves.length === 2 * i + 1, '第 ' + (2 * i + 1) + ' 手后好友收到状态，实际 ' + (foe.view && foe.view.moves.length));

  await waitFor(() => foe.view && foe.view.turn === 'b');
  const blueMove = pickRandomMove(foe.view.board, 'b');
  ok(!!blueMove, '好友总能找到蓝方合法走法');
  if (!blueMove) break;
  foe.conn.send({ t: 'action', a: { type: 'move', from: blueMove.from, path: blueMove.path } });
  await waitFor(() => foe.view && foe.view.moves.length === 2 * i + 2);
  ok(foe.view && foe.view.moves.length === 2 * i + 2, '第 ' + (2 * i + 2) + ' 手后好友收到状态，实际 ' + (foe.view && foe.view.moves.length));
  plies = 2 * i + 2;
}
await waitFor(() => foe.view && foe.view.moves.length === 12);
ok(plies === 12, '双方共走 12 手，实际 ' + plies);
ok(svgAll('circle.piece').length === 20, '走子后棋子仍 20 颗');
ok(svgAll('circle.piece.r').length === 10 && svgAll('circle.piece.b').length === 10, '红蓝各 10 颗');
ok(hostBoard().join(',') === foe.view.board.join(','), '房主 DOM 棋盘与好友视图一致');
ok(document.querySelectorAll('#move-list li').length === 6, '棋谱 6 行，实际 ' + document.querySelectorAll('#move-list li').length);
ok(svgAll('circle.last').length === foe.view.lastMove.path.length, 'last 标记数 = 最后路径长度');
ok(/甲：/.test($('chat-log').textContent) && /乙：/.test($('chat-log').textContent), '走子系统消息进聊天');
ok(foe.states >= 12, '好友持续收到状态，实际 ' + foe.states);
ok(hostTurn() === 'r', '12 手后轮到红方');

/* ---------------- 悔棋（房主请求，好友同意） ---------------- */

const movesBeforeUndo = foe.view.moves.length;
const undoBtn = findBtn($('actions'), '悔棋');
ok(undoBtn && !undoBtn.disabled, '轮到自己时可以点悔棋');
if (undoBtn) undoBtn.click();
await waitFor(() => foe.view && foe.view.offers.undo === 0);
ok(foe.view.offers.undo === 0, '好友收到悔棋请求');
ok(/等待对方同意/.test($('offer-bar').textContent), '房主端显示「等待对方同意」');
foe.conn.send({ t: 'action', a: { type: 'undoReply', accept: true } });
await waitFor(() => foe.view && foe.view.moves.length === movesBeforeUndo - 2);
ok(foe.view.moves.length === movesBeforeUndo - 2, '悔棋回退两手：' + movesBeforeUndo + ' → ' + foe.view.moves.length);
ok(document.querySelectorAll('#move-list li').length === 5, '悔棋后棋谱 5 行');
ok(svgAll('circle.piece').length === 20, '悔棋后棋子仍是 20 颗');
ok($('offer-bar').classList.contains('hidden'), '悔棋完成后请求条消失');
ok(svgAll('circle.last').length === foe.view.lastMove.path.length, '悔棋后 last 标记跟着回退');

/* ---------------- 求和（好友发起，房主拒绝） ---------------- */

foe.conn.send({ t: 'action', a: { type: 'draw' } });
await waitFor(() => foe.view && foe.view.offers.draw === 1 && !$('offer-bar').classList.contains('hidden'));
ok(foe.view.offers.draw === 1, '房主收到求和请求');
ok(/乙 请求求和/.test($('offer-bar').textContent), '求和请求条文案，实际：' + $('offer-bar').textContent);
const rejectDraw = findBtn($('offer-bar'), '拒绝');
ok(!!rejectDraw, '有「拒绝」按钮');
if (rejectDraw) rejectDraw.click();
await waitFor(() => foe.view && foe.view.offers.draw === null && foe.view.phase === 'play');
ok(foe.view.offers.draw === null, '拒绝后请求消失');
ok(foe.view.phase === 'play', '拒绝求和后对局继续');
ok($('offer-bar').classList.contains('hidden'), '拒绝后请求条隐藏');

/* ---------------- 聊天 ---------------- */

foe.conn.send({ t: 'chat', text: '这步跳得漂亮' });
await waitFor(() => /这步跳得漂亮/.test($('chat-log').textContent));
ok(/这步跳得漂亮/.test($('chat-log').textContent), '房主能看到好友的聊天');
await waitFor(() => foe.chats.some((m) => m && m.text === '这步跳得漂亮'));
ok(foe.chats.some((m) => m && m.text === '这步跳得漂亮'), '好友能看到自己发出的消息（房主回显）');
$('chat-input').value = '开跳！';
$('chat-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
await waitFor(() => foe.chats.some((m) => m && m.text === '开跳！'));
ok(/开跳！/.test($('chat-log').textContent), '房主聊天本地显示');
ok(foe.chats.some((m) => m && m.text === '开跳！'), '好友收到房主聊天');

/* ---------------- 观众 ---------------- */

const spec = joinAs('观众丙');
await waitFor(() => spec.view && spec.states > 0);
ok(spec.spectator === true, '第三位自动成为观众');
ok(typeof spec.seat === 'number' && spec.seat >= 2, '观众拿到观战座位号，实际 ' + spec.seat);
ok(spec.view && spec.view.spectator === true, '观众收到观战视角');
ok(spec.view && spec.view.mySide === null, '观众没有执方');
await waitFor(() => $('side-spec').textContent === '观战 1');
ok($('side-spec').textContent === '观战 1', '房主端显示观战人数，实际：' + $('side-spec').textContent);

// 观众加入后再走两手，确认观众也同步
await waitFor(() => hostTurn() === 'r');
const redMove2 = pickRandomMove(hostBoard(), 'r');
ok(!!redMove2, '观众加入后红方有合法走法');
if (redMove2) hostPlay(redMove2);
await waitFor(() => foe.view && foe.view.moves.length === 11);
const blueMove2 = pickRandomMove(foe.view.board, 'b');
ok(!!blueMove2, '观众加入后蓝方有合法走法');
if (blueMove2) foe.conn.send({ t: 'action', a: { type: 'move', from: blueMove2.from, path: blueMove2.path } });
await waitFor(() => foe.view && foe.view.moves.length === 12 && spec.view && spec.view.moves.length === 12);
ok(foe.view.moves.length === 12, '补回两手后 12 手，实际 ' + foe.view.moves.length);
ok(spec.view.moves.length === foe.view.moves.length, '观众与好友手数一致');
ok(spec.states >= 3, '观众持续收到状态，实际 ' + spec.states);

/* ---------------- 认输 → 结算 → 再来一局 ---------------- */

let resignBtn = findBtn($('actions'), '认输');
ok(!!resignBtn, '有认输按钮');
if (resignBtn) resignBtn.click();
await tick(5);
resignBtn = findBtn($('actions'), '确定认输');
ok(!!resignBtn, '认输需要二次确认（第一次只变文字）');
if (resignBtn) resignBtn.click();
await waitFor(() => foe.view && foe.view.phase === 'over' && spec.view && spec.view.phase === 'over');
ok(!$('overlay').classList.contains('hidden'), '结束后弹出结算浮层');
ok($('overlay').dataset.mode === 'result', '结算浮层 mode=result');
ok(/你输了/.test($('overlay-panel').textContent), '房主（红方）认输后显示「你输了」，实际：' + $('overlay-panel').textContent);
ok(/蓝方胜（认输）/.test($('overlay-panel').textContent), '结算副标题含「蓝方胜（认输）」');
ok(foe.view.result && foe.view.result.winner === 'b', '好友收到结果：蓝方胜');
ok(foe.view.result && foe.view.result.reason === 'resign', '结束原因是认输');
ok(spec.view.phase === 'over', '观众也收到结果');

// 非房主 restart 被拒绝
foe.conn.send({ t: 'action', a: { type: 'restart' } });
await waitFor(() => foe.toasts.some((m) => /只有房主能开新局/.test(String(m || ''))));
ok(foe.toasts.some((m) => /只有房主能开新局/.test(String(m || ''))), '非房主 restart 被拒绝（只有房主能开新局）');

const again = findBtn($('overlay-panel'), '再来一局');
ok(!!again, '房主有「再来一局」');
if (again) again.click();
await waitFor(() => foe.view && foe.view.phase === 'play' && foe.view.moves.length === 0);
ok(foe.view.phase === 'play', '再来一局后好友回到对局');
ok(foe.view.moves.length === 0, '新一局棋谱清空');
ok(svgAll('circle.piece').length === 20, '新一局棋盘 20 颗棋子');
ok(svgAll('circle.last').length === 0, '新一局没有 last 标记');
ok($('overlay').classList.contains('hidden'), '再来一局后关闭结算浮层');
ok(/新的一局开始，红方先行/.test($('chat-log').textContent), '再来一局系统消息');

/* ---------------- 掉线重连 ---------------- */

foe.conn.close();
await waitFor(() => !!document.querySelector('#t-players .player-chip .off'));
ok(!!document.querySelector('#t-players .player-chip .off'), '掉线后房主端显示离线标记');
ok(/掉线/.test($('chat-log').textContent), '掉线系统消息');
const foeBack = joinAs('乙');
await waitFor(() => foeBack.view && foeBack.view.phase === 'play' && !document.querySelector('#t-players .player-chip .off'), 2500);
ok(foeBack.seat === 1, '同名重连应该回到 1 号位，实际 ' + foeBack.seat);
ok(foeBack.view && foeBack.view.phase === 'play', '重连后立刻收到当前局面');
ok(!document.querySelector('#t-players .player-chip .off'), '重连后离线标记消失');

/* ---------------- 满员拒绝（2 玩家 + 6 观众） ---------------- */

for (let i = 0; i < 5; i++) joinAs('围观' + i);
await waitFor(() => $('side-spec').textContent === '观战 6', 3000);
ok($('side-spec').textContent === '观战 6', '观众席已满 6 人，实际：' + $('side-spec').textContent);
const extra = joinAs('多出来的');
await waitFor(() => extra.full === true, 2500);
ok(extra.full === true, '第 9 个人应该被拒绝（房间已满）');

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
    conn.send({ t: 'joined', seat: 1, code: 'TEST', side: 'b', spectator: false });
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
  '✅ 端到端通过：房号 ' + code + '｜好友入座｜走棋 12 手｜悔棋｜求和拒绝｜聊天｜观战｜认输重开｜非房主 restart 被拒｜掉线重连｜满员拒绝｜hello 重发'
);
process.exit(0);
