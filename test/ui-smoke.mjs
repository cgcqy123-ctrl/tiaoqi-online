// UI 冒烟测试（需要 jsdom）：node test/ui-smoke.mjs
// 覆盖：首页/大厅 → SVG 星形棋盘（121 hole/121 hit/20 piece/2+2 三角）→ 点棋子选中/点提示落子
//       → 棋谱/last 标记/入营进度 → 各类点击 toast → 入营结算浮层 → 请求条 → 操作栏
//       → 聊天/快捷语/tab/菜单 → 随机整局点击模拟
// 风格对齐五子棋 test/ui-smoke.mjs：problems 收集 + ✅/❌ + process.exit
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

// jsdom 的 SVGElement 没有实现 click()，给整体补上（测试里统一用 dispatchEvent 也行）
if (!dom.window.SVGElement.prototype.click) {
  dom.window.SVGElement.prototype.click = function () {
    this.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
}

const R = await import(url('js/rules.js'));
const { Game } = await import(url('js/game.js'));
const UI = await import(url('js/ui.js'));

const problems = [];
const ok = (cond, msg) => { if (!cond) problems.push(msg); };
const $ = (id) => document.getElementById(id);
const sel = (s) => document.querySelector('#board-svg ' + s);
const all = (s) => document.querySelectorAll('#board-svg ' + s);
const clickEl = (el, desc) => {
  ok(!!el, desc || '元素存在');
  if (el) el.click();
};
const clickHit = (id, desc) => clickEl(sel('circle.hit[data-id="' + id + '"]'), desc || '热区 ' + id);
const findBtn = (root, text) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text)) || null;
const pieceCount = (side) => all('circle.piece.' + side).length;

let pending = null;
/** 渲染棋桌：把 game.view(seat) 挂上与 main.js 相同的装饰字段 */
function renderGame(game, seat = 0, opt = {}) {
  const v = game.view(seat);
  v._code = opt.code || 'AB12';
  v._isHost = opt.isHost !== undefined ? opt.isHost : seat === 0;
  v._spectators = opt.spectators || [];
  UI.resetSelection();
  pending = null;
  UI.renderTable(v, (act) => { pending = act; });
  return v;
}
/** 固定种子伪随机，保证整局模拟可复现 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
/** 构造「9 子已在目标营 + 第 10 子紧挨空位」的入营胜利局面 */
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
  ok(goalHole >= 0 && from >= 0, '应能构造入营胜利局面');
  const board = new Array(R.SIZE).fill(null);
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

UI.bindUI();

/* ---------------- 首页 / 大厅 ---------------- */

UI.showScreen('home');
ok(!$('scr-home').classList.contains('hidden'), '首页应可见');
ok($('scr-lobby').classList.contains('hidden'), '房间页应隐藏');
ok($('scr-table').classList.contains('hidden'), '棋桌应隐藏');

UI.renderLobby({
  code: 'AB12',
  players: [{ name: '甲', connected: true }, { name: null, connected: false }],
  spectators: [],
  isHost: true,
  canStart: false,
  tip: '测试提示',
  youSeat: 0,
});
ok($('lobby-code').textContent === 'AB12', '房号显示');
let seats = document.querySelectorAll('#seat-list li.seat-item');
ok(seats.length === 2, '座位列表 2 项（红/蓝），实际 ' + seats.length);
ok(seats[0] && seats[0].classList.contains('filled') && seats[0].classList.contains('red'), '0 号位有名字且是红方');
ok(seats[1] && !seats[1].classList.contains('filled') && seats[1].classList.contains('blue'), '1 号位空着且是蓝方');
ok(seats[0].querySelector('.idx').textContent === '红', '红方标记');
ok(seats[1].querySelector('.idx').textContent === '蓝', '蓝方标记');
ok(/红方 · 先行/.test(seats[0].querySelector('.tag').textContent), '红方先行标签');
ok(/蓝方/.test(seats[1].querySelector('.tag').textContent), '蓝方标签');
ok(/（你）/.test(seats[0].querySelector('.nm').textContent), 'youSeat 显示「（你）」');
ok($('lobby-spec').textContent === '第 3 位起自动成为观战', '无观众时的提示，实际：' + $('lobby-spec').textContent);
ok($('btn-start').disabled === true, '人不齐不能开始');
ok(!$('btn-start').classList.contains('hidden'), '房主能看到开始按钮');
ok(/等待对手入座（1\/2）/.test($('btn-start').textContent), '开始按钮显示人数进度，实际：' + $('btn-start').textContent);
ok($('lobby-tip').textContent === '测试提示', '大厅 tip 透传');

UI.renderLobby({
  code: 'AB12',
  players: [{ name: '甲', connected: true }, { name: '乙', connected: false }],
  spectators: ['旁观者', '路人'],
  isHost: true,
  canStart: true,
  youSeat: 0,
  tip: '',
});
seats = document.querySelectorAll('#seat-list li.seat-item');
ok($('btn-start').disabled === false, '两人齐了可以开始');
ok($('btn-start').textContent === '开始对局', '开始按钮文案');
ok(/观战：旁观者、路人/.test($('lobby-spec').textContent), '观战名单');
ok(/离线/.test(seats[1].textContent), '掉线座位显示离线');
ok(/把房号发给朋友/.test($('lobby-tip').textContent), '房主默认 tip');

UI.renderLobby({
  code: 'ZZ99',
  players: [{ name: '甲', connected: true }, { name: '乙', connected: true }],
  spectators: [],
  isHost: false,
  canStart: true,
  tip: '',
  youSeat: 1,
});
ok($('btn-start').classList.contains('hidden'), '非房主看不到开始按钮');
ok($('lobby-tip').textContent === '等待房主开始对局…', '非房主默认 tip');
ok(/（你）/.test(document.querySelectorAll('#seat-list li.seat-item')[1].textContent), '1 号位 youSeat 标记');

/* ---------------- 棋桌：SVG 星形棋盘 ---------------- */

const g = new Game([{ name: '甲' }, { name: '乙' }]).start();
renderGame(g, 0);
ok(!$('scr-table').classList.contains('hidden'), '渲染后进入棋桌');
ok($('scr-lobby').classList.contains('hidden'), '大厅隐藏');
const svgEl = $('board-svg');
const expectViewBox = [R.VIEW.x, R.VIEW.y, R.VIEW.w, R.VIEW.h].join(' ');
ok(svgEl.getAttribute('viewBox') === expectViewBox, 'viewBox = VIEW，实际：' + svgEl.getAttribute('viewBox'));
ok(svgEl.getAttribute('preserveAspectRatio') === 'xMidYMid meet', 'preserveAspectRatio 契约值');

ok(all('circle.hole').length === 121, '121 个 circle.hole，实际 ' + all('circle.hole').length);
ok(all('circle.hit').length === 121, '121 个 circle.hit，实际 ' + all('circle.hit').length);
const hitIds = [...all('circle.hit')].map((e) => e.getAttribute('data-id'));
ok(new Set(hitIds).size === 121 && hitIds.every((s) => /^\d+$/.test(s)), '121 个热区 data-id 唯一且是数字');
ok(all('circle.hit[data-id="111"]').length === 1, '热区 data-id 可定位孔');
ok(all('circle.piece').length === 20, '开局 20 颗棋子，实际 ' + all('circle.piece').length);
ok(pieceCount('r') === 10, '红方 10 颗，实际 ' + pieceCount('r'));
ok(pieceCount('b') === 10, '蓝方 10 颗，实际 ' + pieceCount('b'));
ok(all('circle.piece.r[data-id="111"]').length === 1, '红方出发营 111 号有红子');
ok(all('circle.piece.b[data-id="0"]').length === 1, '蓝方出发营 0 号有蓝子');
ok(all('polygon.board-tri').length === 2, '2 个棋盘大三角');
ok(all('polygon.home-tri').length === 2, '2 个营三角');
ok(all('polygon.home-tri.home-red').length === 1 && all('polygon.home-tri.home-blue').length === 1, '红/蓝营三角分类');
ok(all('circle.last').length === 0, '开局没有上一步标记');
ok(all('circle.hint').length === 0, '开局没有提示圈');
ok(all('circle.hit.mine').length === 10, '轮到自己时自己的 10 个棋子热区带 mine，实际 ' + all('circle.hit.mine').length);

ok($('move-list').textContent.includes('红方先行，还没有走棋'), '空棋谱提示');
ok($('move-list').querySelectorAll('li').length === 1 && $('move-list').querySelector('li.empty'), '空棋谱占位 li');
ok(/轮到你走棋（红方）/.test($('actions').textContent), '红方先手提示，实际：' + $('actions').textContent);
ok($('t-code').textContent === 'AB12', '棋桌房号显示');
ok($('t-room').textContent === '甲 vs 乙', '对阵显示，实际：' + $('t-room').textContent);
ok($('side-spec').textContent === '', '无观众时观战数为空');
ok($('offer-bar').classList.contains('hidden'), '没有请求时请求条隐藏');

const chips = document.querySelectorAll('#t-players .player-chip');
ok(chips.length === 2, '两个玩家 chip，实际 ' + chips.length);
ok(!!document.querySelector('#t-players .dot-side.r') && !!document.querySelector('#t-players .dot-side.b'), '红蓝执方圆点');
ok(chips[0].classList.contains('active'), '当前走棋方（红）chip 高亮');
ok(chips[0].classList.contains('me'), '自己（红）chip 有 me 类');
ok([...document.querySelectorAll('#t-players .goal')].every((x) => /^入营 \d\/10$/.test(x.textContent)), '玩家条有入营进度');
ok([...document.querySelectorAll('#t-players .goal')].map((x) => x.textContent).join('|') === '入营 0/10|入营 0/10', '开局入营 0/10');

/* ---------------- 选中 / 提示 / 走子 ---------------- */

clickHit(111, '红方 111 号热区');
ok(all('circle.piece.selected').length === 1, '选中后只有 1 颗棋子带 selected，实际 ' + all('circle.piece.selected').length);
ok(all('circle.piece.selected[data-id="111"]').length === 1, '选中的是 111 号');
ok(all('circle.hint').length === 2, '111 号有 2 个合法落点，实际 ' + all('circle.hint').length);
ok([...all('circle.hint')].map((e) => e.getAttribute('data-id')).join(',') === '103,102', '提示落点 103/102');
ok(all('circle.hit.mine').length === 9, '选中后自己的热区 mine 少一个');

clickHit(111, '再次点 111 取消选中');
ok(all('circle.piece.selected').length === 0 && all('circle.hint').length === 0, '再点同一颗棋子取消选中');

clickHit(111, '重新选中 111');
const boardBefore = g.board.slice();
const expectPath = R.reachable(boardBefore, 111).get(103);
ok(Array.isArray(expectPath), 'rules 能算出 111→103 路径');
clickHit(103, '点提示落点 103');
ok(pending && pending.type === 'move' && pending.from === 111, '点提示落点发出 move，实际：' + JSON.stringify(pending));
ok(pending && pending.path.join(',') === expectPath.join(','), '动作 path 与 rules.reachable 完全一致，实际：' + JSON.stringify(pending && pending.path));

g.action(0, pending);
renderGame(g, 0);
ok(all('circle.piece').length === 20, '走子后棋子仍 20 颗');
ok(pieceCount('r') === 10 && pieceCount('b') === 10, '双方仍各 10 颗');
ok(all('circle.last').length === 2, '上一步标记数 = 路径长度 2，实际 ' + all('circle.last').length);
ok([...all('circle.last')].map((e) => e.getAttribute('data-id')).join(',') === '111,103', 'last 标记在路径上');
ok($('move-list').querySelectorAll('li').length === 1, '棋谱两两一行');
ok($('move-list').querySelector('.r').textContent === '走 1 步', '红方记谱在 .r');
ok($('move-list').querySelector('.b').textContent === '', '蓝方还没走，.b 为空');
ok($('move-list').querySelector('li.newest') !== null, '最新一行有 newest');
ok(/等待 乙 走棋/.test($('actions').textContent), '轮到对手时等待提示，实际：' + $('actions').textContent);
ok(document.querySelector('#t-players .player-chip.active .dot-side').classList.contains('b'), '活跃 chip 换成蓝方');
ok(all('circle.hit.mine').length === 0, '不是自己回合时没有 mine 热区');

// 蓝方视角：选中自己的子并走一步跳
renderGame(g, 1);
ok(/轮到你走棋（蓝方）/.test($('actions').textContent), '蓝方回合提示');
ok(all('circle.hit.mine').length === 10, '蓝方视角自己 10 个 mine');
clickHit(3, '蓝方 3 号热区');
ok([...all('circle.hint')].map((e) => e.getAttribute('data-id')).join(',') === '16,14', '蓝方 3 号落点 16/14');
ok(all('circle.hit.mine').length === 9, '选中后蓝方 mine 少一个');
clickHit(16, '点蓝方落点 16');
ok(pending && pending.type === 'move' && pending.from === 3 && pending.path.join(',') === '3,16', '蓝方动作 {from:3,path:[3,16]}');
g.action(1, pending);
renderGame(g, 1);
ok($('move-list').querySelectorAll('li').length === 1, '两手在同一行棋谱');
ok($('move-list').querySelector('.b').textContent === '跳 1 下', '蓝方记谱是「跳 1 下」');
ok(all('circle.last').length === 2, '蓝方上一步标记 2 个');
ok(/等待 甲 走棋/.test($('actions').textContent), '蓝方视角等待红方');

/* ---------------- 各类点击 toast ---------------- */

// 对方棋子（红方视角、轮到红方时点蓝子）
renderGame(g, 0);
clickHit(0, '红方视角点蓝子');
ok($('toast').textContent === '那不是你的棋子', '点对方棋子提示，实际：' + $('toast').textContent);

// 非自己回合：蓝方视角但轮到红方
renderGame(g, 1);
clickHit(111, '蓝方视角点红子');
ok($('toast').textContent === '还没轮到你走棋', '非自己回合提示，实际：' + $('toast').textContent);

// 观战
const vs = renderGame(g, -1, { spectators: ['甲', '乙', '丙'] });
ok(vs.spectator === true && vs.mySide === null, '观战视图字段');
ok(/观战中/.test($('actions').textContent), '观战状态提示');
clickHit(60, '观战点棋盘');
ok($('toast').textContent === '观战中，只能看棋', '观战点棋盘提示，实际：' + $('toast').textContent);
ok(all('circle.hit.mine').length === 0, '观战没有 mine 热区');
ok($('side-spec').textContent === '观战 3', '观战人数显示，实际：' + $('side-spec').textContent);
ok(document.querySelectorAll('#actions button').length === 0, '观战没有操作按钮');
ok(document.querySelectorAll('#t-players .player-chip.me').length === 0, '观战没有 me 类');

// 点空格取消选中（红方回合）
renderGame(g, 0);
ok(/轮到你走棋（红方）/.test($('actions').textContent), '又轮到红方');
clickHit(103, '选中红方 103 号');
ok(all('circle.hint').length > 0, '选中后有提示');
clickHit(60, '点一个不可达空格');
ok(all('circle.hint').length === 0 && all('circle.piece.selected').length === 0, '点不可达空格取消选中，实际 hints=' + all('circle.hint').length);

/* ---------------- 入营结算浮层 ---------------- */

const redWin = nearWinSetup(R.HOME_TOP, R.HOME_BOTTOM, R.RED, R.BLUE);
const gw = new Game([{ name: '甲' }, { name: '乙' }]).start();
gw.board = redWin.board.slice();
gw.turn = R.RED;
renderGame(gw, 0);
clickHit(redWin.from, '选中即将入营的红子');
ok([...all('circle.hint')].some((e) => e.getAttribute('data-id') === String(redWin.goalHole)), '最后一个目标营空位在提示里');
clickHit(redWin.goalHole, '点最后一个目标营空位');
ok(pending && pending.type === 'move', '最后一手发出 move');
gw.action(0, pending);
renderGame(gw, 0);
ok(gw.phase === 'over', '补满 10 子后对局结束');
ok(!$('overlay').classList.contains('hidden'), '结束后显示结算浮层');
ok($('overlay').dataset.mode === 'result', '浮层 dataset.mode=result');
ok(/你赢了！/.test($('overlay-panel').textContent), '赢家标题「你赢了！」，实际：' + $('overlay-panel').textContent);
ok(/红方胜（全部入营） · 共 1 手/.test($('overlay-panel').textContent), '结算副标题含胜因与手数');
ok(!!findBtn($('overlay-panel'), '再来一局'), '房主有「再来一局」');
ok(document.querySelectorAll('#t-players .goal')[0].textContent === '入营 10/10', '赢家入营进度 10/10');
ok(document.querySelectorAll('#actions button').length === 0, '结束后操作栏没有按钮');
ok(/本局结束/.test($('actions').textContent), '结束后状态文字');
findBtn($('overlay-panel'), '再来一局').click();
ok(pending && pending.type === 'restart', '再来一局发出 restart');

// 输家视角
renderGame(gw, 1);
ok(/你输了/.test($('overlay-panel').textContent), '输家标题「你输了」');
ok(/等待房主开新局…/.test($('overlay-panel').textContent), '非房主等待房主开新局');
ok(!findBtn($('overlay-panel'), '再来一局'), '非房主没有「再来一局」');

// 观战视角
renderGame(gw, -1);
ok(/红方胜/.test($('overlay-panel').textContent), '观战标题显示「红方胜」');
ok(/观战结束/.test($('overlay-panel').textContent), '观战结算提示');
ok(!findBtn($('overlay-panel'), '再来一局'), '观战没有「再来一局」');

// 结束后点棋盘
renderGame(gw, 0);
clickHit(60, '结束后点棋盘');
ok($('toast').textContent === '对局还没开始或已经结束', '结束后点棋盘提示，实际：' + $('toast').textContent);

// 蓝方获胜的标题（红方视角应该显示你输了）
const blueWin = nearWinSetup(R.HOME_BOTTOM, R.HOME_TOP, R.BLUE, R.RED);
const gw2 = new Game([{ name: '甲' }, { name: '乙' }]).start();
gw2.board = blueWin.board.slice();
gw2.turn = R.BLUE;
gw2.move(1, blueWin.from, [blueWin.from, blueWin.goalHole]);
renderGame(gw2, 1);
ok(/你赢了！/.test($('overlay-panel').textContent), '蓝方赢家视角标题');
renderGame(gw2, 0);
ok(/你输了/.test($('overlay-panel').textContent), '蓝方获胜时红方视角「你输了」');

/* ---------------- 请求条：悔棋 / 求和 ---------------- */

const g3 = new Game([{ name: '甲' }, { name: '乙' }]).start();
g3.move(0, 111, [111, 103]);
g3.requestUndo(0);
renderGame(g3, 1); // 蓝方视角：对方请求悔棋
ok(!$('offer-bar').classList.contains('hidden'), '对方请求悔棋时出现请求条');
ok(/甲 请求悔棋/.test($('offer-bar').textContent), '悔棋请求条文案，实际：' + $('offer-bar').textContent);
ok(!!findBtn($('offer-bar'), '同意') && !!findBtn($('offer-bar'), '拒绝'), '请求条有同意/拒绝按钮');
findBtn($('offer-bar'), '同意').click();
ok(pending && pending.type === 'undoReply' && pending.accept === true, '同意按钮发出 undoReply(accept:true)');
renderGame(g3, 1);
findBtn($('offer-bar'), '拒绝').click();
ok(pending && pending.type === 'undoReply' && pending.accept === false, '拒绝按钮发出 undoReply(accept:false)');

// 请求方视角
renderGame(g3, 0);
ok(/已发出悔棋请求，等待对方同意…/.test($('offer-bar').textContent), '请求方看到等待文案，实际：' + $('offer-bar').textContent);
ok(!findBtn($('offer-bar'), '同意'), '请求方没有同意按钮');
ok(findBtn($('actions'), '求和') && findBtn($('actions'), '求和').disabled === true, '请求挂起时「求和」按钮禁用');
ok(findBtn($('actions'), '悔棋') && findBtn($('actions'), '悔棋').disabled === true, '请求挂起时「悔棋」按钮禁用');

// 观战能看到请求，但不能回应
renderGame(g3, -1);
ok(/甲 请求悔棋/.test($('offer-bar').textContent), '观战也能看到请求条');
ok($('offer-bar').querySelectorAll('button').length === 0, '观战没有回应按钮');

// 求和
const g4 = new Game([{ name: '甲' }, { name: '乙' }]).start();
g4.move(0, 111, [111, 103]);
g4.offerDraw(0);
renderGame(g4, 1);
ok(/甲 请求求和/.test($('offer-bar').textContent), '求和请求条文案，实际：' + $('offer-bar').textContent);
findBtn($('offer-bar'), '同意').click();
ok(pending && pending.type === 'drawReply' && pending.accept === true, '同意求和发出 drawReply');
renderGame(g4, 0);
ok(/已发出求和请求，等待对方同意…/.test($('offer-bar').textContent), '求和请求方等待文案');

/* ---------------- 操作栏 ---------------- */

const g5 = new Game([{ name: '甲' }, { name: '乙' }]).start();
renderGame(g5, 0);
ok(findBtn($('actions'), '悔棋') && findBtn($('actions'), '悔棋').disabled === true, '还没走棋时悔棋按钮禁用');
ok(findBtn($('actions'), '求和') && findBtn($('actions'), '求和').disabled === false, '无请求时求和按钮可用');
let resignBtn = findBtn($('actions'), '认输');
ok(!!resignBtn, '有认输按钮');
resignBtn.click();
ok(pending === null, '第一次点认输只进入二次确认，不发动作');
resignBtn = findBtn($('actions'), '确定认输');
ok(!!resignBtn, '第一次点后文字变「确定认输」');
resignBtn.click();
ok(pending && pending.type === 'resign', '第二次点发 resign');

const g6 = new Game([{ name: '甲' }, { name: '乙' }]).start();
g6.move(0, 111, [111, 103]);
renderGame(g6, 0);
ok(findBtn($('actions'), '悔棋') && findBtn($('actions'), '悔棋').disabled === false, '走过棋后可以悔棋');
renderGame(g6, 1);
ok(findBtn($('actions'), '悔棋') && findBtn($('actions'), '悔棋').disabled === true, '蓝方还没走棋，悔棋禁用');

/* ---------------- 聊天 / 快捷语 / tab ---------------- */

const sent = [];
UI.setChatSender((text) => sent.push(text));
UI.renderChat(
  [
    { kind: 'sys', text: '甲 加入了房间' },
    { kind: 'say', name: '甲', text: '你好' },
    { kind: 'say', name: '我', text: '跳得漂亮' },
  ],
  '我'
);
ok(document.querySelectorAll('#chat-log .msg').length === 3, '聊天显示 3 条');
ok(!!document.querySelector('#chat-log .msg.sys'), '系统消息样式独立');
ok(!!document.querySelector('#chat-log .msg.me'), '自己的消息有 me 类');
ok(!!document.querySelector('#chat-log .msg .who'), '玩家消息带昵称');
const many = [];
for (let i = 0; i < 70; i++) many.push({ kind: 'say', name: '甲', text: '第 ' + i + ' 条' });
UI.renderChat(many, '甲');
ok(document.querySelectorAll('#chat-log .msg').length === 60, '聊天最多保留 60 条，实际 ' + document.querySelectorAll('#chat-log .msg').length);
UI.renderChat([{ kind: 'sys', text: '甲 加入了房间' }, { kind: 'say', name: '甲', text: '你好' }], '我');

$('chat-input').value = ' 好棋  ';
$('chat-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
ok(sent.length === 1 && sent[0] === '好棋', '表单提交去空格后发送，实际：' + JSON.stringify(sent));
ok($('chat-input').value === '', '发送后清空输入');
const quickBtns = document.querySelectorAll('#quick button');
ok(quickBtns.length === 6, '6 个快捷语，实际 ' + quickBtns.length);
quickBtns[0].click();
ok(sent.length === 2 && sent[1] === quickBtns[0].textContent, '快捷语点击发送');

$('tab-chat').click();
ok(!$('chat-pane').classList.contains('hidden'), '切到聊天显示聊天面板');
ok($('move-list').classList.contains('hidden'), '聊天时隐藏棋谱');
ok($('tab-chat').classList.contains('active') && !$('tab-moves').classList.contains('active'), 'tab 激活态切换');
$('tab-moves').click();
ok(!$('move-list').classList.contains('hidden') && $('chat-pane').classList.contains('hidden'), '切回棋谱');

/* ---------------- 菜单浮层 ---------------- */

let quitCalled = 0;
UI.showMenu({ code: 'AB12', role: 'host', onQuit: () => quitCalled++ });
ok(!$('overlay').classList.contains('hidden'), '菜单浮层显示');
ok($('overlay').dataset.mode === 'menu', '菜单 dataset.mode=menu');
ok(/房间 AB12/.test($('overlay-panel').textContent), '菜单显示房号');
ok(/房主/.test($('overlay-panel').textContent), '菜单显示角色说明');
findBtn($('overlay-panel'), '关闭').click();
ok($('overlay').classList.contains('hidden'), '关闭菜单');

UI.showMenu({ code: 'AB12', role: 'spectator', onQuit: () => quitCalled++ });
ok(/观战/.test($('overlay-panel').textContent), '观战角色说明');
findBtn($('overlay-panel'), '离开房间').click();
ok(quitCalled === 1, '离开房间触发回调');
ok($('overlay').classList.contains('hidden'), '离开后关闭浮层');

// 菜单和结算浮层互斥
UI.showMenu({ code: 'AB12', role: 'host' });
renderGame(gw, 0);
ok($('overlay').dataset.mode === 'menu', '菜单打开时渲染棋桌不覆盖菜单');
UI.clearOverlay();
renderGame(gw, 0);
ok($('overlay').dataset.mode === 'result' && /你赢了！/.test($('overlay-panel').textContent), '关掉菜单后结算浮层恢复');

/* ---------------- 整局模拟：点击走到底 ---------------- */

const rand = rng(2026);
const gs = new Game([{ name: '甲' }, { name: '乙' }]).start();
let simGuard = 0;
while (gs.phase === 'play' && simGuard < 15) {
  const side = gs.turn;
  const seat = side === R.RED ? 0 : 1;
  renderGame(gs, seat);
  ok(all('circle.piece').length === 20, '模拟中棋子数始终 20');
  const moves = [];
  for (let i = 0; i < R.SIZE; i++) {
    if (gs.board[i] !== side) continue;
    for (const m of R.legalMoves(gs.board, i)) moves.push({ from: i, ...m });
  }
  ok(moves.length > 0, '模拟中轮到方有棋可走');
  const pick = moves[Math.floor(rand() * moves.length)];
  const expectHints = R.reachable(gs.board, pick.from).size;
  clickHit(pick.from, '模拟选中棋子');
  ok(all('circle.hint').length === expectHints, '模拟中提示数 = reachable 数，实际 ' + all('circle.hint').length + ' / ' + expectHints);
  clickHit(pick.to, '模拟点落点');
  ok(pending && pending.type === 'move' && pending.from === pick.from && pending.path.join(',') === pick.path.join(','), '模拟动作与 rules 一致');
  if (!pending) break;
  gs.action(seat, pending);
  simGuard++;
}
renderGame(gs, gs.turn === R.RED ? 0 : 1);
ok(gs.history.length === 15, '模拟对局走了 15 手，实际 ' + gs.history.length);
ok(all('circle.piece').length === 20, '整局后棋子仍 20');
ok(pieceCount('r') === 10 && pieceCount('b') === 10, '整局后红蓝各 10');
ok(all('circle.last').length === gs.lastMove.path.length, '整局后 last 标记数 = 最后路径长度');
ok($('move-list').querySelectorAll('li').length === Math.ceil(gs.history.length / 2), '棋谱行数 = ceil(手数/2)，实际 ' + $('move-list').querySelectorAll('li').length);
const goals = [...document.querySelectorAll('#t-players .goal')].map((x) => x.textContent);
ok(goals[0] === '入营 ' + R.inGoal(gs.board, R.RED) + '/10', '红方入营进度与实际一致，实际：' + goals[0]);
ok(goals[1] === '入营 ' + R.inGoal(gs.board, R.BLUE) + '/10', '蓝方入营进度与实际一致，实际：' + goals[1]);
ok(all('circle.hit').length === 121, '整局后热区仍 121');

/* ---------------- 汇总 ---------------- */

if (problems.length) {
  console.error('❌ UI 冒烟测试失败：\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('✅ UI 冒烟测试通过（121 孔 / 20 子 / 选中提示 / 入营结算 / 请求条 / 聊天 / 菜单 / 模拟对局 ' + gs.history.length + ' 手）');
process.exit(0);
