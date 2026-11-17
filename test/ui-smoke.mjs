// UI 冒烟测试（2-6 人，需要 jsdom）：node test/ui-smoke.mjs
// 覆盖：首页人数选择器 → 大厅 2/3/6 座位 → 2/3/6 人 SVG 星形棋盘（六营/目标营/棋子 c0..c5）
//       → 点棋子选中/点提示落子 → 多人棋谱（一行一手）→ 各类点击 toast
//       → 多人求和请求条（进度/同意/拒绝）→ 悔棋请求条 → 操作栏 → 结算（winner=0 与 -1）
//       → 聊天/快捷语/tab/菜单 → 2/3/6 人随机整局点击模拟
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

// jsdom 的 SVGElement 没有 click()，补一个（棋盘热区都是 SVG circle）
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
const all = (s) => document.querySelectorAll('#board-svg ' + s);
const clickEl = (el, desc) => { ok(!!el, desc || '元素存在'); if (el) el.click(); };
const clickHit = (id, desc) => clickEl(document.querySelector('#board-svg circle.hit[data-id="' + id + '"]'), desc || '热区 ' + id);
const findBtn = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text)) || null;
const dotSeat = (dot) => {
  const cls = [...dot.classList].find((c) => /^c\d$/.test(c));
  return cls ? Number(cls.slice(1)) : -1;
};
const makePlayers = (n) => Array.from({ length: n }, (_, i) => ({ name: ['甲', '乙', '丙', '丁', '戊', '己'][i] || 'P' + i }));
const newGame = (n) => new Game(makePlayers(n), n).start();

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
function movesOf(board, seat) {
  const out = [];
  for (let i = 0; i < R.SIZE; i++) {
    if (board[i] !== seat) continue;
    for (const m of R.legalMoves(board, i)) out.push({ from: i, to: m.to, path: m.path });
  }
  return out;
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
/** 构造「某座位 9 子在目标营 + 第 10 子紧挨空位」的入营胜利局面 */
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
  ok(goalHole >= 0 && from >= 0, '应能构造入营胜利局面');
  const board = new Array(R.SIZE).fill(null);
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
  }
  return { board, from, goalHole };
}

UI.bindUI();

/* ---------------- 首页 / 大厅 ---------------- */

UI.showScreen('home');
ok(!$('scr-home').classList.contains('hidden'), '首页应可见');
ok($('scr-table').classList.contains('hidden'), '棋桌应隐藏');
const pickBtns = document.querySelectorAll('#count-pick button[data-n]');
ok(pickBtns.length === 5, '首页人数选择器 5 个按钮（2-6 人），实际 ' + pickBtns.length);
ok([...pickBtns].map((b) => b.dataset.n).join(',') === '2,3,4,5,6', '人数按钮 data-n 是 2..6');

// 2 人：1 人已入座
UI.renderLobby({
  code: 'AB12',
  players: [{ name: '甲', connected: true }, { name: null, connected: false }],
  spectators: [],
  isHost: true,
  canStart: false,
  tip: '测试提示',
  youSeat: 0,
  playerCount: 2,
});
let seats = document.querySelectorAll('#seat-list li.seat-item');
ok(seats.length === 2, '2 人局大厅 2 个座位');
ok(seats[0].classList.contains('filled') && seats[0].classList.contains('c0'), '0 号位有名字 + c0 颜色类');
ok(seats[1].classList.contains('c1') && !seats[1].classList.contains('filled'), '1 号位空位 + c1 颜色类');
ok(seats[0].querySelector('.idx').className.includes('c0'), '.idx 带 c0 颜色类');
ok(seats[1].querySelector('.idx').textContent === '蓝', '1 号位颜色名蓝');
ok(/红方 · 先行/.test(seats[0].querySelector('.tag').textContent), '0 号位 tag 红方 · 先行');
ok(/蓝方/.test(seats[1].querySelector('.tag').textContent), '1 号位 tag 蓝方');
ok(/（你）/.test(seats[0].querySelector('.nm').textContent), 'youSeat 显示（你）');
ok($('btn-start').textContent === '等待玩家入座 (1/2)', '开始按钮显示人数进度，实际：' + $('btn-start').textContent);
ok($('btn-start').disabled === true, '人不齐不能开始');
ok(!$('btn-start').classList.contains('hidden'), '房主能看到开始按钮');
ok($('lobby-spec').textContent === '满 2 人后，多出来的人自动观战', '观战文案，实际：' + $('lobby-spec').textContent);
ok($('lobby-tip').textContent === '测试提示', '大厅 tip 透传');

// 3 人：两人到齐
UI.renderLobby({
  code: 'AB12',
  players: [{ name: '甲', connected: true }, { name: '乙', connected: true }, { name: null, connected: false }],
  spectators: ['旁观者'],
  isHost: true,
  canStart: false,
  tip: '',
  youSeat: 0,
  playerCount: 3,
});
seats = document.querySelectorAll('#seat-list li.seat-item');
ok(seats.length === 3, '3 人局大厅 3 个座位，实际 ' + seats.length);
ok([...seats].map((s) => s.className).join('|') === 'seat-item c0 filled|seat-item c1 filled|seat-item c2', '3 个座位颜色/填充类正确');
ok($('btn-start').textContent === '等待玩家入座 (2/3)', '3 人局进度文案，实际：' + $('btn-start').textContent);
ok(/观战：旁观者/.test($('lobby-spec').textContent), '观战名单');
ok(/把房号发给朋友/.test($('lobby-tip').textContent), '房主默认 tip');

// 6 人：全满，可以开始
UI.renderLobby({
  code: 'CD34',
  players: makePlayers(6).map((p) => ({ name: p.name, connected: true })),
  spectators: [],
  isHost: true,
  canStart: true,
  tip: '',
  youSeat: 0,
  playerCount: 6,
});
seats = document.querySelectorAll('#seat-list li.seat-item');
ok(seats.length === 6, '6 人局大厅 6 个座位');
ok(seats[5].querySelector('.idx').textContent === '青', '6 号座位颜色名青');
ok($('btn-start').textContent === '开始对局', '人齐时按钮文案');
ok($('btn-start').disabled === false, '人齐可以开始');
ok($('lobby-spec').textContent === '满 6 人后，多出来的人自动观战', '6 人观战文案');

// 客人占位：players 空数组也能渲染，非房主看不到开始按钮
UI.renderLobby({ code: 'ZZ99', players: [], spectators: [], isHost: false, canStart: false, tip: '正在进入房间…', youSeat: -1, playerCount: 4 });
ok(document.querySelectorAll('#seat-list li').length === 4, 'players 为空时按 playerCount 渲染 4 个占位座位');
ok($('btn-start').classList.contains('hidden'), '非房主看不到开始按钮');
ok($('lobby-tip').textContent === '正在进入房间…', '占位 tip');

/* ---------------- 棋桌：2/3/6 人 SVG 星形棋盘 ---------------- */

const expectViewBox = [R.VIEW.x, R.VIEW.y, R.VIEW.w, R.VIEW.h].join(' ');
for (const n of [2, 3, 6]) {
  const g = newGame(n);
  renderGame(g, 0);
  ok(!$('scr-table').classList.contains('hidden'), 'n=' + n + ' 渲染后进入棋桌');
  ok($('board-svg').getAttribute('viewBox') === expectViewBox, 'n=' + n + ' viewBox = R.VIEW');
  ok(all('circle.hole').length === 121, 'n=' + n + ' 121 个 hole，实际 ' + all('circle.hole').length);
  ok(all('circle.hit').length === 121, 'n=' + n + ' 121 个 hit，实际 ' + all('circle.hit').length);
  ok(all('circle.piece').length === 10 * n, 'n=' + n + ' 共 ' + 10 * n + ' 颗棋子，实际 ' + all('circle.piece').length);
  for (let seat = 0; seat < n; seat++) {
    ok(all('circle.piece.c' + seat).length === 10, 'n=' + n + ' 座位 ' + seat + ' 有 10 颗 c' + seat + ' 棋子');
  }
  ok(all('circle.piece.c0').length === 10 && all('circle.piece.c1').length === 10, 'n=' + n + ' 棋子按座位号 c0/c1 上色');
  ok(all('polygon.home-tri').length === 6, 'n=' + n + ' 固定画 6 个营三角');
  ok(all('polygon.home-tri.owner').length === n, 'n=' + n + ' 有 ' + n + ' 个营有主人，实际 ' + all('polygon.home-tri.owner').length);
  ok(all('polygon.home-tri.empty').length === 6 - n, 'n=' + n + ' 空营 ' + (6 - n) + ' 个');
  ok(all('polygon.home-ring').length === n, 'n=' + n + ' 目标营虚线环数量 = 玩家数，实际 ' + all('polygon.home-ring').length);
  ok(all('circle.hit.mine').length === 10, 'n=' + n + ' 轮到自己时自己 10 个 mine 热区');
  ok(document.querySelectorAll('#t-players .player-chip').length === n, 'n=' + n + ' 玩家 chip ' + n + ' 个');
  ok(document.querySelectorAll('#t-players .goal').length === n, 'n=' + n + ' 玩家条有入营进度');
  ok([...document.querySelectorAll('#t-players .goal')].every((x) => x.textContent === '入营 0/10'), 'n=' + n + ' 开局入营 0/10');
  ok([...document.querySelectorAll('#t-players .dot-side')].map(dotSeat).join(',') === Array.from({ length: n }, (_, i) => i).join(','), 'n=' + n + ' 玩家 chip 颜色点 c0..c' + (n - 1));
  ok($('t-room').textContent.indexOf(n + ' 人局') === 0, 'n=' + n + ' 对阵显示人数，实际：' + $('t-room').textContent);
  ok($('move-list').textContent.includes('红方先行，还没有走棋'), 'n=' + n + ' 空棋谱文案');
  ok(/轮到你走棋（红方）/.test($('actions').textContent), 'n=' + n + ' 红方先手提示，实际：' + $('actions').textContent);
  ok($('offer-bar').classList.contains('hidden'), 'n=' + n + ' 没有请求时请求条隐藏');
}

/* ---------------- 选中 / 提示 / 落子（3 人，座位 0 的棋子值是 0） ---------------- */

const g3 = newGame(3);
renderGame(g3, 0);
ok(all('circle.hit.mine').length === 10, '3 人局红方 10 个 mine');
// 座位 0 的棋子值是 0：必须能选中
const seat0Ids = R.seatHomeIds(0, 3).filter((id) => R.legalMoves(g3.board, id).length > 0);
ok(seat0Ids.length > 0, '红方有可走的子');
const from0 = seat0Ids[0];
ok(g3.board[from0] === 0, '选中的是座位 0 的棋子（值 0）');
clickHit(from0, '点红方棋子');
ok(all('circle.piece.selected').length === 1, '选中 1 颗棋子');
ok(all('circle.piece.selected[data-id="' + from0 + '"]').length === 1, '选中的棋子带 selected');
const expectHints = R.reachable(g3.board, from0).size;
ok(all('circle.hint').length === expectHints, '提示圈数 = rules.reachable 数，实际 ' + all('circle.hint').length + ' / ' + expectHints);
ok(all('circle.hit.mine').length === 9, '选中后自己的 mine 热区少一个');
const hintTo = Number(document.querySelector('#board-svg circle.hint').getAttribute('data-id'));
const expectPath = R.reachable(g3.board, from0).get(hintTo);
clickHit(hintTo, '点提示落点');
ok(pending && pending.type === 'move' && pending.from === from0, '点提示落点发出 move，实际：' + JSON.stringify(pending));
ok(pending && pending.path.join(',') === expectPath.join(','), '动作 path 与 rules.reachable 完全一致');
g3.action(0, pending);
renderGame(g3, 0);
ok(all('circle.piece').length === 30, '走子后棋子仍 30 颗');
ok(all('circle.last').length === expectPath.length, '上一手标记数 = 路径长度，实际 ' + all('circle.last').length);
ok(document.querySelectorAll('#move-list li').length === 1, '棋谱一行一手');
const moveLi = document.querySelector('#move-list li');
ok(!!moveLi.querySelector('.no') && !!moveLi.querySelector('.dot.c0') && !!moveLi.querySelector('.who'), '棋谱行有 序号/颜色点/名字');
ok(moveLi.querySelector('.who').textContent === '甲', '棋谱行显示走子玩家名');
ok(moveLi.querySelector('.notation').textContent === R.moveNotation(expectPath), '棋谱行显示 notation');
ok(moveLi.classList.contains('newest'), '最新一行有 newest');
ok(/等待 乙 走棋/.test($('actions').textContent), '轮到对手时等待提示，实际：' + $('actions').textContent);
ok(dotSeat(document.querySelector('#t-players .player-chip.active .dot-side')) === 1, '活跃 chip 换成座位 1');

// 座位 1 / 2 视角各走一步（先让座位 0 走，轮到座位 1）
const g4 = newGame(3);
const m0 = movesOf(g4.board, 0)[0];
g4.move(0, m0.from, m0.path);
renderGame(g4, 1);
ok(/轮到你走棋（蓝方）/.test($('actions').textContent), '座位 1 回合提示');
const m1 = movesOf(g4.board, 1)[0];
clickHit(m1.from, '点座位 1 的棋子');
clickHit(m1.to, '点座位 1 的落点');
ok(pending && pending.from === m1.from && pending.path.join(',') === m1.path.join(','), '座位 1 动作正确');
g4.action(1, pending);
renderGame(g4, 1);
ok(all('circle.last').length === m1.path.length, '座位 1 走子后 last 标记');
const m2 = movesOf(g4.board, 2)[0];
g4.move(2, m2.from, m2.path);
renderGame(g4, 0);
const lis = document.querySelectorAll('#move-list li');
ok(lis.length === 3, '3 人局棋谱一行一手，共 3 行，实际 ' + lis.length);
ok(lis[0].querySelector('.dot.c0') && lis[1].querySelector('.dot.c1') && lis[2].querySelector('.dot.c2'), '棋谱每行颜色点对应座位号');
ok(lis[2].classList.contains('newest') && !lis[0].classList.contains('newest'), 'newest 只在最后一行');

/* ---------------- 点击 toast ---------------- */

// 观战
const vs = renderGame(g4, -1, { spectators: ['甲', '乙', '丙'] });
ok(vs.spectator === true && vs.seat === -1, '观战视图');
ok(/观战中/.test($('actions').textContent), '观战状态提示');
clickHit(60, '观战点棋盘');
ok($('toast').textContent === '观战中，只能看棋', '观战点棋盘提示，实际：' + $('toast').textContent);
ok(all('circle.hit.mine').length === 0, '观战没有 mine 热区');
ok($('side-spec').textContent === '观战 3', '观战人数显示，实际：' + $('side-spec').textContent);
ok(document.querySelectorAll('#actions button').length === 0, '观战没有操作按钮');

// 非回合（座位 1 视角但轮到座位 0）
const gt = newGame(3);
renderGame(gt, 1);
const own1 = R.seatHomeIds(1, 3).find((id) => R.legalMoves(gt.board, id).length > 0);
clickHit(own1, '非回合点自己的棋子');
ok($('toast').textContent === '还没轮到你走棋', '非自己回合提示，实际：' + $('toast').textContent);

// 对方棋子（座位 0 视角点座位 1 的棋子）
renderGame(gt, 0);
const foePiece = R.seatHomeIds(1, 3).find((id) => R.legalMoves(gt.board, id).length > 0);
clickHit(foePiece, '点对方棋子');
ok($('toast').textContent === '那不是你的棋子', '点对方棋子提示，实际：' + $('toast').textContent);

// 点空格取消选中
renderGame(gt, 0);
const mineId = R.seatHomeIds(0, 3).find((id) => R.legalMoves(gt.board, id).length > 0);
clickHit(mineId, '选中自己的棋子');
ok(all('circle.hint').length > 0, '选中后有提示圈');
clickHit(60, '点不可达的空格');
ok(all('circle.hint').length === 0 && all('circle.piece.selected').length === 0, '点不可达空格取消选中');

/* ---------------- 多人求和请求条 ---------------- */

const gd = newGame(3);
gd.offerDraw(1);
renderGame(gd, 0);
ok(!$('offer-bar').classList.contains('hidden'), '求和请求条显示');
ok(/乙 请求求和/.test($('offer-bar').textContent), '请求条文案，实际：' + $('offer-bar').textContent);
ok(!!findBtn($('offer-bar'), '同意') && !!findBtn($('offer-bar'), '拒绝'), '请求条有同意/拒绝按钮');
findBtn($('offer-bar'), '同意').click();
ok(pending && pending.type === 'drawReply' && pending.accept === true, '同意按钮发出 drawReply(accept:true)');
renderGame(gd, 0);
findBtn($('offer-bar'), '拒绝').click();
ok(pending && pending.type === 'drawReply' && pending.accept === false, '拒绝按钮发出 drawReply(accept:false)');

// 发起者视角：显示进度（0/2）
renderGame(gd, 1);
ok(/已发出求和请求，等待其他玩家同意（0\/2）/.test($('offer-bar').textContent), '发起者进度 0/2，实际：' + $('offer-bar').textContent);
ok($('offer-bar').querySelectorAll('button').length === 0, '发起者没有回应按钮');

// 已同意的人看到等待；其他人看到进度
gd.replyDraw(0, true);
renderGame(gd, 0);
ok(/你已同意求和，等待其他玩家…/.test($('offer-bar').textContent), '已同意者等待文案，实际：' + $('offer-bar').textContent);
renderGame(gd, 2);
ok(/乙 请求求和（已同意 1\/2）/.test($('offer-bar').textContent), '其他玩家看到同意进度，实际：' + $('offer-bar').textContent);
ok(!!findBtn($('offer-bar'), '同意'), '其他玩家仍有同意按钮');
renderGame(gd, -1);
ok(/乙 请求求和/.test($('offer-bar').textContent) && $('offer-bar').querySelectorAll('button').length === 0, '观战能看到求和请求但没有按钮');

// 6 人局：需要 5 人同意
const gd6 = newGame(6);
gd6.offerDraw(0);
for (const s of [1, 2, 3, 4]) gd6.replyDraw(s, true);
renderGame(gd6, 0);
ok(/（4\/5）/.test($('offer-bar').textContent), '6 人局发起者进度 4/5，实际：' + $('offer-bar').textContent);
renderGame(gd6, 5);
ok(/（已同意 4\/5）/.test($('offer-bar').textContent), '6 人局最后一位看到 4/5 进度，实际：' + $('offer-bar').textContent);
findBtn($('offer-bar'), '同意').click();
ok(pending && pending.type === 'drawReply' && pending.accept === true, '第 5 位同意发出 drawReply');

/* ---------------- 悔棋请求条 ---------------- */

const gu = newGame(3);
for (let i = 0; i < 3; i++) {
  const seat = gu.turn;
  const m = movesOf(gu.board, seat)[0];
  gu.move(seat, m.from, m.path);
}
gu.requestUndo(0);
renderGame(gu, 2);
ok(!$('offer-bar').classList.contains('hidden'), '悔棋请求条显示');
ok(/甲 请求悔棋/.test($('offer-bar').textContent), '悔棋请求条文案，实际：' + $('offer-bar').textContent);
findBtn($('offer-bar'), '拒绝').click();
ok(pending && pending.type === 'undoReply' && pending.accept === false, '拒绝悔棋发出 undoReply(accept:false)');
renderGame(gu, 0);
ok(/已发出悔棋请求，等待其他玩家同意…/.test($('offer-bar').textContent), '悔棋发起者等待文案，实际：' + $('offer-bar').textContent);
ok(findBtn($('actions'), '求和') && findBtn($('actions'), '求和').disabled === true, '请求挂起时求和禁用');
ok(findBtn($('actions'), '悔棋') && findBtn($('actions'), '悔棋').disabled === true, '请求挂起时悔棋禁用');

/* ---------------- 操作栏 ---------------- */

const ga = newGame(3);
renderGame(ga, 0);
ok(findBtn($('actions'), '悔棋') && findBtn($('actions'), '悔棋').disabled === true, '还没走棋时悔棋禁用');
ok(findBtn($('actions'), '求和') && findBtn($('actions'), '求和').disabled === false, '无请求时求和可用');
let resignBtn = findBtn($('actions'), '认输');
ok(!!resignBtn, '有认输按钮');
resignBtn.click();
ok(pending === null, '第一次点认输只进入二次确认');
resignBtn = findBtn($('actions'), '确定认输');
ok(!!resignBtn, '第一次点后文字变「确定认输」');
resignBtn.click();
ok(pending && pending.type === 'resign', '第二次点发 resign');

const ga2 = newGame(3);
const am = movesOf(ga2.board, 0)[0];
ga2.move(0, am.from, am.path);
renderGame(ga2, 0);
ok(findBtn($('actions'), '悔棋') && findBtn($('actions'), '悔棋').disabled === false, '走过棋后可以悔棋');
renderGame(ga2, 1);
ok(findBtn($('actions'), '悔棋') && findBtn($('actions'), '悔棋').disabled === true, '没走过的玩家悔棋禁用');

/* ---------------- 结算浮层 ---------------- */

function renderWinGame() {
  const s = nearWinSetup(0, 3);
  const g = newGame(3);
  g.board = s.board.slice();
  g.turn = 0;
  renderGame(g, 0);
  clickHit(s.from, '选中即将入营的棋子');
  clickHit(s.goalHole, '点最后一个目标营空位');
  ok(pending && pending.type === 'move', '最后一手发出 move');
  g.action(0, pending);
  return g;
}
const gw = renderWinGame();
renderGame(gw, 0);
ok(gw.phase === 'over', '补满 10 子后对局结束');
ok(!$('overlay').classList.contains('hidden'), '结束后显示结算浮层');
ok($('overlay').dataset.mode === 'result', '浮层 dataset.mode=result');
ok(/你赢了！/.test($('overlay-panel').textContent), 'winner=0（座位 0 是有效胜者）显示你赢了！，实际：' + $('overlay-panel').textContent);
ok(/甲 全部入营，获胜 · 共 1 手/.test($('overlay-panel').textContent), '结算副标题含胜因与手数');
ok(!!findBtn($('overlay-panel'), '再来一局'), '房主有「再来一局」');
ok(document.querySelectorAll('#t-players .goal')[0].textContent === '入营 10/10', '赢家入营进度 10/10');
ok(document.querySelectorAll('#actions button').length === 0, '结束后操作栏没有按钮');
ok(/本局结束/.test($('actions').textContent), '结束后状态文字');
findBtn($('overlay-panel'), '再来一局').click();
ok(pending && pending.type === 'restart', '再来一局发出 restart');

renderGame(gw, 1);
ok(/你输了/.test($('overlay-panel').textContent), '输家标题「你输了」');
ok(/等待房主开新局…/.test($('overlay-panel').textContent), '非房主等待房主开新局');
renderGame(gw, -1);
ok(/甲 获胜/.test($('overlay-panel').textContent), '观战标题「甲 获胜」，实际：' + $('overlay-panel').textContent);
ok(/观战结束/.test($('overlay-panel').textContent), '观战结算提示');
ok(!findBtn($('overlay-panel'), '再来一局'), '观战没有「再来一局」');

// 多人认输：winner=-1 → 对局结束
const gr = newGame(3);
gr.resign(1);
renderGame(gr, 0);
ok($('overlay').dataset.mode === 'result', '多人认输也显示结算');
ok(/对局结束/.test($('overlay-panel').textContent), '多人认输标题「对局结束」，实际：' + $('overlay-panel').textContent);
ok(/乙 认输，本局结束 · 共 0 手/.test($('overlay-panel').textContent), '多人认输副标题');
renderGame(gr, -1);
ok(/对局结束/.test($('overlay-panel').textContent), '观战看多人认输也是对局结束');

// 和棋：winner=-1 + reason draw → 和棋
const gdraw = newGame(3);
gdraw.offerDraw(0);
gdraw.replyDraw(1, true);
gdraw.replyDraw(2, true);
renderGame(gdraw, 1);
ok(/和棋/.test($('overlay-panel').textContent), '和棋标题「和棋」，实际：' + $('overlay-panel').textContent);
ok(/和棋（全部玩家同意） · 共 0 手/.test($('overlay-panel').textContent), '和棋副标题');

// 菜单和结算浮层互斥
UI.showMenu({ code: 'AB12', role: 'host' });
renderGame(gw, 0);
ok($('overlay').dataset.mode === 'menu', '菜单打开时渲染棋桌不覆盖菜单');
UI.clearOverlay();
renderGame(gw, 0);
ok($('overlay').dataset.mode === 'result' && /你赢了！/.test($('overlay-panel').textContent), '关掉菜单后结算浮层恢复');

// 结束后点棋盘
renderGame(gw, 0);
clickHit(60, '结束后点棋盘');
ok($('toast').textContent === '对局还没开始或已经结束', '结束后点棋盘提示，实际：' + $('toast').textContent);

/* ---------------- 聊天 / 快捷语 / tab / 菜单 ---------------- */

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
const many = [];
for (let i = 0; i < 70; i++) many.push({ kind: 'say', name: '甲', text: '第 ' + i + ' 条' });
UI.renderChat(many, '甲');
ok(document.querySelectorAll('#chat-log .msg').length === 60, '聊天最多保留 60 条，实际 ' + document.querySelectorAll('#chat-log .msg').length);
UI.renderChat([{ kind: 'sys', text: '甲 加入了房间' }], '我');
$('chat-input').value = ' 好棋  ';
$('chat-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
ok(sent.length === 1 && sent[0] === '好棋', '表单提交去空格后发送');
ok($('chat-input').value === '', '发送后清空输入');
const quickBtns = document.querySelectorAll('#quick button');
ok(quickBtns.length === 6, '6 个快捷语，实际 ' + quickBtns.length);
quickBtns[0].click();
ok(sent.length === 2 && sent[1] === quickBtns[0].textContent, '快捷语点击发送');
$('tab-chat').click();
ok(!$('chat-pane').classList.contains('hidden') && $('move-list').classList.contains('hidden'), '切到聊天面板');
$('tab-moves').click();
ok(!$('move-list').classList.contains('hidden') && $('chat-pane').classList.contains('hidden'), '切回棋谱');

let quitCalled = 0;
UI.showMenu({ code: 'AB12', role: 'host', onQuit: () => quitCalled++ });
ok($('overlay').dataset.mode === 'menu' && /房间 AB12/.test($('overlay-panel').textContent), '菜单显示房号');
ok(/房主/.test($('overlay-panel').textContent), '菜单显示角色说明');
findBtn($('overlay-panel'), '关闭').click();
ok($('overlay').classList.contains('hidden'), '关闭菜单');
UI.showMenu({ code: 'AB12', role: 'spectator', onQuit: () => quitCalled++ });
ok(/观战/.test($('overlay-panel').textContent), '观战角色说明');
findBtn($('overlay-panel'), '离开房间').click();
ok(quitCalled === 1 && $('overlay').classList.contains('hidden'), '离开房间触发回调并关闭浮层');

/* ---------------- 整局模拟：2/3/6 人点击走 12 手 ---------------- */

for (const n of [2, 3, 6]) {
  const rand = rng(2026 + n);
  const gs = newGame(n);
  for (let ply = 0; ply < 12; ply++) {
    const seat = gs.turn;
    renderGame(gs, seat);
    ok(all('circle.piece').length === 10 * n, 'n=' + n + ' 模拟中棋子数 = 10n');
    ok(all('circle.piece.c' + seat).length === 10, 'n=' + n + ' 模拟中轮到座位 ' + seat + ' 的棋子 10 颗');
    const ms = movesOf(gs.board, seat);
    ok(ms.length > 0, 'n=' + n + ' 模拟中轮到方有棋可走');
    const pick = ms[Math.floor(rand() * ms.length)];
    const expectHintCount = R.reachable(gs.board, pick.from).size;
    clickHit(pick.from, '模拟选中');
    ok(all('circle.hint').length === expectHintCount, 'n=' + n + ' 模拟提示数 = reachable 数');
    clickHit(pick.to, '模拟点落点');
    ok(pending && pending.type === 'move' && pending.from === pick.from && pending.path.join(',') === pick.path.join(','), 'n=' + n + ' 模拟动作与 rules 一致');
    if (!pending) break;
    gs.action(seat, pending);
  }
  renderGame(gs, gs.turn);
  ok(gs.history.length === 12, 'n=' + n + ' 模拟 12 手，实际 ' + gs.history.length);
  ok(all('circle.piece').length === 10 * n, 'n=' + n + ' 12 手后棋子仍 10n');
  ok(all('circle.last').length === gs.lastMove.path.length, 'n=' + n + ' last 标记数 = 最后路径长度');
  ok(document.querySelectorAll('#move-list li').length === 12, 'n=' + n + ' 棋谱 12 行（一行一手），实际 ' + document.querySelectorAll('#move-list li').length);
  ok(all('circle.hit').length === 121, 'n=' + n + ' 整局后热区仍 121');
  ok(document.querySelectorAll('#t-players .goal').length === n, 'n=' + n + ' 整局后玩家条数量');
  for (let s = 0; s < n; s++) {
    ok(document.querySelectorAll('#t-players .goal')[s].textContent === '入营 ' + R.inGoal(gs.board, s, n) + '/10', 'n=' + n + ' 座位 ' + s + ' 入营进度与实际一致');
  }
}

/* ---------------- 汇总 ---------------- */

if (problems.length) {
  console.error('❌ UI 冒烟测试失败：\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('✅ UI 冒烟测试通过（2/3/6 人：座位/六营/目标环/多人和求条/结算 winner=0 与 -1/三人行棋谱/模拟各 12 手）');
process.exit(0);
