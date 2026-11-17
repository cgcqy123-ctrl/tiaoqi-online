// 入口：串起大厅、房间、对局和网络
//
// 缓存穿透：所有子模块都带上 index.html 里 script 标签的 ?v=xxx，
// 以后改版只要把 index.html 里的版本号 +1，浏览器就不会继续用旧缓存。
//
// 角色分工：房主（host）是唯一权威，跑对局状态机、校验走子、广播视图；
// 其他玩家和所有观众只提交动作 / 收视图。
//
// 2-6 人：房主在首页选人数；座位号就是棋子编码（0 也是有效棋子，判空一律 === null）。

const V = new URL(import.meta.url).search;
const { Game, PHASE } = await import('./game.js' + V);
const R = await import('./rules.js' + V);
const { HostRoom, GuestRoom, normalizeCode } = await import('./net.js' + V);
const UI = await import('./ui.js' + V);

const $ = (id) => document.getElementById(id);

/** Safari 隐私模式 / 关闭 Cookie 时 localStorage 会直接抛异常，必须兜底，否则整个页面启动失败 */
const store = {
  get(key) {
    try { return localStorage.getItem(key) || ''; } catch (_) { return ''; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* Safari 隐私模式等，忽略即可 */ }
  },
};

/** 座位安排：0 = 房主（红方，先行），1..N-1 = 其他玩家；观战座号 = playerCount + 观战序号，最多 6 个观战 */
const MAX_SPECS = 6;
const CHAT_KEEP = 60;

const S = {
  name: '',
  role: null, // 'host' | 'guest'
  seat: 0,
  code: '',
  playerCount: 2, // 房主在首页选的人数（2-6），创建房间后固定
  host: null,
  guest: null,
  game: null,
  lobbySeats: null, // 房主侧：长度 = playerCount 的 [{name, connected}]
  spec: [], // 房主侧：S.spec[i] = 观战座号 playerCount+i 的观众昵称，null = 空位
  remoteSpecs: [], // 加入者侧：房主同步过来的观众昵称
  chat: [],
  busy: false,
};

/* ---------------- 通用 ---------------- */

function clampCount(n) {
  const v = Number(n);
  return R.PLAYER_COUNTS.includes(v) ? v : 2;
}

function getName() {
  const v = $('in-name').value.trim().slice(0, 8);
  if (!v) {
    UI.toast('先填个昵称');
    $('in-name').focus();
    return '';
  }
  store.set('tiaoqi-name', v);
  return v;
}

function lock(on) {
  S.busy = on;
  for (const id of ['btn-create', 'btn-join']) {
    const el = $(id);
    if (el) el.disabled = on;
  }
}

function resetAll() {
  try { S.host && S.host.closeAll(); } catch (_) { /* ignore */ }
  try { S.guest && S.guest.close(); } catch (_) { /* ignore */ }
  S.host = null;
  S.guest = null;
  S.game = null;
  S.role = null;
  S.seat = 0;
  S.code = '';
  S.lobbySeats = null;
  S.spec = [];
  S.remoteSpecs = [];
  S.chat = [];
  UI.clearOverlay();
  UI.resetSelection();
  UI.renderChat([], S.name);
  UI.showScreen('home');
}

function decorate(view, isHost) {
  view._code = S.code;
  view._isHost = !!isHost;
  view._spectators = S.role === 'host' ? S.spec.filter(Boolean) : S.remoteSpecs || [];
  // 契约 §2 要求视图带 camps；万一 game.view 没填（或旧缓存模块），这里按人数补一份，保证 UI 能画营
  if (!Array.isArray(view.camps)) view.camps = R.campsForCount(view.count || S.playerCount);
  return view;
}

function pushChat(entry) {
  S.chat.push(entry);
  if (S.chat.length > CHAT_KEEP) S.chat.shift();
  UI.renderChat(S.chat, S.name);
}

function makeSys(text) {
  return { kind: 'sys', text, ts: Date.now() };
}

function sysMsg(text) {
  const entry = makeSys(text);
  pushChat(entry);
  return entry;
}

/* ---------------- 座位 / 名字 ---------------- */

/** 座位号是不是玩家位（0..playerCount-1）；观战位从 playerCount 起 */
function isPlayerSeat(seat) {
  return Number.isInteger(seat) && seat >= 0 && seat < S.playerCount;
}

/** 玩家座位对应的营下标；观战返回 null */
function campOf(seat) {
  return isPlayerSeat(seat) ? R.campsForCount(S.playerCount)[seat] : null;
}

function seatName(seat) {
  if (!isPlayerSeat(seat)) return S.spec[seat - S.playerCount] || '观众';
  return (S.lobbySeats && S.lobbySeats[seat] && S.lobbySeats[seat].name) || '玩家';
}

function specNames() {
  return S.spec.filter(Boolean);
}

/** 房主侧：所有还连着、需要接收广播的远端座位（玩家位 + 观战位） */
function remoteSeats() {
  const out = [];
  if (S.lobbySeats) {
    for (let seat = 1; seat < S.playerCount; seat++) {
      const p = S.lobbySeats[seat];
      if (p && p.name && p.connected) out.push(seat);
    }
  }
  S.spec.forEach((n, i) => {
    if (n) out.push(S.playerCount + i);
  });
  return out;
}

/* ---------------- 房主 ---------------- */

async function createRoom() {
  const name = getName();
  if (!name || S.busy) return;
  lock(true);
  S.role = 'host';
  S.seat = 0;
  S.name = name;
  S.playerCount = clampCount(S.playerCount);
  S.lobbySeats = Array.from({ length: S.playerCount }, (_, seat) =>
    seat === 0 ? { name, connected: true } : { name: null, connected: false });
  S.spec = [];
  S.chat = [];
  try {
    const room = new HostRoom({
      onHello: hostOnHello,
      onMessage: hostOnMessage,
      onSeatGone: hostOnSeatGone,
      onError: (m) => UI.toast(m),
    });
    S.host = room;
    S.code = await room.open();
    hostRenderLobby();
    sysMsg('房间 ' + S.code + ' 已创建（' + S.playerCount + ' 人局），把房号发给朋友吧');
  } catch (e) {
    UI.toast(e && e.message ? e.message : '创建房间失败');
    resetAll();
  } finally {
    lock(false);
  }
}

/** 给某个座位补发 joined（首次入座和 Safari 重复 hello 幂等重发共用） */
function hostSendJoined(seat) {
  const isSpec = !isPlayerSeat(seat);
  S.host.send(seat, {
    t: 'joined',
    seat,
    code: S.code,
    spectator: isSpec,
    playerCount: S.playerCount,
    camp: isSpec ? null : campOf(seat),
  });
}

/** 给某个座位发大厅同步 */
function hostSendLobby(seat) {
  S.host.send(seat, {
    t: 'lobby',
    code: S.code,
    players: S.lobbySeats,
    spectators: specNames(),
    playerCount: S.playerCount,
    youSeat: seat,
  });
}

function hostOnHello(conn, name, existingSeat) {
  if (!S.lobbySeats) {
    S.host.sendRaw(conn, { t: 'full' });
    return;
  }
  const clean = (name || '').trim().slice(0, 8) || '玩家';

  // 重发 hello（Safari 丢第一条消息时）：连接已绑座位，幂等补发入座信息和大厅
  if (existingSeat !== undefined && existingSeat !== null) {
    hostSendJoined(existingSeat);
    S.host.send(existingSeat, { t: 'chatLog', list: S.chat });
    hostSendLobby(existingSeat);
    if (S.game && S.game.phase !== PHASE.LOBBY) pushStates();
    else hostRenderLobby();
    return;
  }

  let seat = -1;

  // 1) 同名且离线的玩家优先回座（房主座位 0 不参与，房主不会掉线重连）
  for (let s = 1; s < S.playerCount; s++) {
    const p = S.lobbySeats[s];
    if (p && p.name === clean && !p.connected) {
      seat = s;
      break;
    }
  }
  // 2) 第一个空玩家座位
  if (seat < 0) {
    for (let s = 1; s < S.playerCount; s++) {
      if (!S.lobbySeats[s].name) {
        seat = s;
        break;
      }
    }
  }
  // 3) 玩家满：观战位（优先复用空掉的观战位，再追加，最多 MAX_SPECS 个）
  if (seat < 0) {
    const free = S.spec.findIndex((n) => !n);
    if (free >= 0) {
      seat = S.playerCount + free;
      S.spec[free] = clean;
    } else if (S.spec.length < MAX_SPECS) {
      seat = S.playerCount + S.spec.length;
      S.spec.push(clean);
    }
  }

  if (seat < 0) {
    S.host.sendRaw(conn, { t: 'full' });
    setTimeout(() => { try { conn.close(); } catch (_) { /* ignore */ } }, 600);
    return;
  }

  S.host.bind(conn, seat);
  const isSpec = !isPlayerSeat(seat);
  if (!isSpec) S.lobbySeats[seat] = { name: clean, connected: true };
  if (S.game && !isSpec) {
    const p = S.game.players.find((x) => x.seat === seat);
    if (p) {
      p.name = clean;
      p.connected = true;
    }
  }

  const entry = sysMsg(clean + (isSpec ? ' 进入观战' : ' 加入了房间'));
  hostSendJoined(seat);
  S.host.send(seat, { t: 'chatLog', list: S.chat });
  hostSendLobby(seat);
  hostBroadcastChat(entry, seat);
  if (!isSpec) UI.toast(clean + ' 加入了房间（' + S.lobbySeats.filter((p) => p.name).length + '/' + S.playerCount + '）');

  if (S.game && S.game.phase !== PHASE.LOBBY) pushStates();
  else hostRenderLobby();
}

function hostOnMessage(seat, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'action') hostAction(seat, msg.a);
  else if (msg.t === 'chat') {
    const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!text) return;
    const entry = { kind: 'say', name: seatName(seat), text, ts: Date.now(), seat };
    pushChat(entry);
    hostBroadcastChat(entry);
  }
}

function hostBroadcastChat(entry, exceptSeat = -1) {
  if (!S.host) return;
  for (const seat of remoteSeats()) {
    if (seat === exceptSeat) continue;
    S.host.send(seat, { t: 'chat', msg: entry });
  }
}

function hostOnSeatGone(seat) {
  if (!S.lobbySeats) return;
  if (!isPlayerSeat(seat)) {
    // 观众退出：清空观战位并广播
    const idx = seat - S.playerCount;
    if (S.spec[idx]) {
      const who = S.spec[idx];
      S.spec[idx] = null;
      while (S.spec.length && !S.spec[S.spec.length - 1]) S.spec.pop();
      const entry = sysMsg(who + ' 退出观战');
      hostBroadcastChat(entry);
    }
  } else {
    // 玩家掉线：保留昵称、标记离线，等他同名重连
    const p = S.lobbySeats[seat];
    if (p && p.name) {
      const who = p.name;
      S.lobbySeats[seat] = { name: who, connected: false };
      if (S.game) {
        const gp = S.game.players.find((x) => x.seat === seat);
        if (gp) gp.connected = false;
      }
      const entry = sysMsg(who + ' 掉线了，等待重连…');
      hostBroadcastChat(entry);
      UI.toast(who + ' 掉线了，等待重连');
    }
  }
  if (S.game && S.game.phase !== PHASE.LOBBY) pushStates();
  else hostRenderLobby();
}

function hostAction(seat, act) {
  if (S.role !== 'host' || !act || typeof act !== 'object') return;
  if (!isPlayerSeat(seat)) {
    UI.toast('观战不能操作');
    return;
  }
  if (act.type === 'restart') {
    if (seat !== 0) {
      if (S.host) S.host.send(seat, { t: 'toast', msg: '只有房主能开新局' });
      return;
    }
    startRound();
    return;
  }
  if (!S.game) return;

  let notation = '';
  let res = null;
  try {
    res = S.game.action(seat, act);
    if (res && res.notation) notation = res.notation;
  } catch (e) {
    const msg = e && e.message ? e.message : '操作无效';
    if (seat === 0) UI.toast(msg);
    else if (S.host) S.host.send(seat, { t: 'toast', msg });
    return;
  }

  const say = (text) => {
    const entry = makeSys(text);
    pushChat(entry);
    hostBroadcastChat(entry);
  };

  if (notation) {
    const last = S.game.history[S.game.history.length - 1];
    say(seatName(last.seat) + '：' + notation);
  }

  // 悔棋 / 求和请求的交互过程也记进聊天，所有玩家都能看到发生了什么
  if (act.type === 'undo' && res && res.ok) say(seatName(seat) + ' 请求悔棋');
  if (act.type === 'undoReply' && res) {
    if (res.accepted) say(seatName(seat) + ' 同意悔棋，回退 ' + res.popped + ' 手');
    else say(seatName(seat) + ' 拒绝了悔棋');
  }
  if (act.type === 'draw' && res && res.ok) {
    say(seatName(seat) + ' 请求求和（需要其他 ' + (S.playerCount - 1) + ' 位玩家都同意）');
  }
  if (act.type === 'drawReply' && res) {
    if (res.rejected) say(seatName(seat) + ' 拒绝了求和');
    else if (res.accepted && res.over) say('所有玩家都同意求和');
    else if (res.accepted) say(seatName(seat) + ' 同意求和（还差 ' + res.waiting + ' 人）');
  }

  if (S.game.phase === PHASE.OVER && S.game.result) say('对局结束 · ' + S.game.result.text);
  pushStates();
}

/** N 个玩家座位都有人且都在线才能开局 / 再来一局 */
function allPlayersReady() {
  if (!S.lobbySeats || S.lobbySeats.length !== S.playerCount) return false;
  return S.lobbySeats.every((p) => !!p && !!p.name && p.connected);
}

function startRound() {
  if (!S.game) return;
  if (!allPlayersReady()) {
    UI.toast('有玩家掉线，等他回来再开新局');
    return;
  }
  UI.clearOverlay();
  UI.resetSelection();
  S.game.start();
  const entry = sysMsg('新的一局开始，红方先行');
  hostBroadcastChat(entry);
  pushStates();
}

function startGame() {
  if (S.role !== 'host') return;
  if (!allPlayersReady()) {
    UI.toast('要 ' + S.playerCount + ' 位玩家都入座才能开始');
    return;
  }
  S.game = new Game(S.lobbySeats.map((p) => ({ name: p.name, connected: p.connected })), S.playerCount);
  startRound();
}

function hostRenderLobby() {
  if (S.role !== 'host' || !S.lobbySeats) return;
  const filled = S.lobbySeats.filter((p) => p && p.name).length;
  const offline = S.lobbySeats.filter((p) => p && p.name && !p.connected).length;
  let tip;
  if (filled < S.playerCount) tip = '把房号 ' + S.code + ' 发给朋友，还差 ' + (S.playerCount - filled) + ' 人（多出来的人自动观战）';
  else if (offline) tip = '有玩家掉线了，等他重新进来';
  else tip = '人齐了，点「开始对局」';
  UI.renderLobby({
    code: S.code,
    players: S.lobbySeats,
    spectators: specNames(),
    youSeat: 0,
    isHost: true,
    canStart: allPlayersReady(),
    tip,
    playerCount: S.playerCount,
  });
  broadcastLobby();
}

function broadcastLobby() {
  if (!S.host || !S.lobbySeats) return;
  for (const seat of remoteSeats()) hostSendLobby(seat);
}

function pushStates() {
  if (S.role !== 'host' || !S.host || !S.game) return;
  for (const seat of remoteSeats()) {
    const view = S.game.view(isPlayerSeat(seat) ? seat : -1);
    S.host.send(seat, { t: 'state', view: decorate(view, false) });
  }
  renderMyTable();
}

function renderMyTable() {
  if (!S.game) return;
  UI.renderTable(decorate(S.game.view(0), true), hostActionLocal);
}

function hostActionLocal(act) {
  hostAction(0, act);
}

/* ---------------- 加入者 ---------------- */

async function joinRoom() {
  const name = getName();
  if (!name || S.busy) return;
  const code = normalizeCode($('in-code').value);
  if (code.length !== 4) {
    UI.toast('房号是 4 位字母数字');
    return;
  }
  lock(true);
  S.role = 'guest';
  S.name = name;
  S.code = code;
  S.chat = [];
  S.remoteSpecs = [];
  try {
    const g = new GuestRoom({
      onMessage: guestOnMessage,
      onClose: () => {
        UI.toast('和房主的连接断开了');
        setTimeout(resetAll, 1200);
      },
      onFail: (m) => UI.toast(m),
      onError: (m) => UI.toast(m),
    });
    S.guest = g;
    await g.join(code, name);
    // 还没收到房主的大厅同步：先用空座位占位（等 lobby 消息到达后渲染真实座位）
    UI.renderLobby({
      code,
      players: [],
      spectators: [],
      youSeat: -1,
      isHost: false,
      canStart: false,
      tip: '正在进入房间…',
      playerCount: S.playerCount,
    });
  } catch (e) {
    UI.toast(e && e.message ? e.message : '加入失败');
    resetAll();
  } finally {
    lock(false);
  }
}

function guestOnMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'joined':
      S.seat = typeof msg.seat === 'number' ? msg.seat : 0;
      S.playerCount = clampCount(msg.playerCount || S.playerCount);
      S.code = msg.code || S.code;
      break;
    case 'lobby':
      S.code = msg.code || S.code;
      S.playerCount = clampCount(msg.playerCount || S.playerCount);
      S.remoteSpecs = msg.spectators || [];
      UI.renderLobby({
        code: S.code,
        players: msg.players || [],
        spectators: msg.spectators || [],
        youSeat: typeof msg.youSeat === 'number' ? msg.youSeat : S.seat,
        isHost: false,
        canStart: false,
        tip: '等待房主开始对局…',
        playerCount: S.playerCount,
      });
      break;
    case 'chatLog':
      S.chat = Array.isArray(msg.list) ? msg.list.slice(-CHAT_KEEP) : [];
      UI.renderChat(S.chat, S.name);
      break;
    case 'chat':
      if (msg.msg) pushChat(msg.msg);
      break;
    case 'state': {
      const view = msg.view;
      if (!view) return;
      UI.renderTable(decorate(view, false), guestActionLocal);
      break;
    }
    case 'toast':
      UI.toast(msg.msg || '');
      break;
    case 'full':
      UI.toast('房间已满（' + S.playerCount + ' 位玩家 + ' + MAX_SPECS + ' 位观战）');
      setTimeout(resetAll, 1500);
      break;
    default:
      break;
  }
}

function guestActionLocal(act) {
  if (!S.guest) return;
  if (!S.guest.send({ t: 'action', a: act })) UI.toast('发送失败，连接可能已断开');
}

/* ---------------- 聊天入口 ---------------- */

function sendChat(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) return;
  if (S.role === 'host') {
    const entry = { kind: 'say', name: S.name, text: clean, ts: Date.now(), seat: 0 };
    pushChat(entry);
    hostBroadcastChat(entry);
  } else if (S.role === 'guest') {
    // 不做本地回显：房主会把同一条消息广播回来，避免重复
    if (S.guest && !S.guest.send({ t: 'chat', text: clean })) UI.toast('发送失败，连接可能已断开');
  }
}

/* ---------------- 绑定事件 ---------------- */

/** 首页人数选择器：选中后 S.playerCount 生效，创建房间时使用 */
function bindCountPicker() {
  const box = $('count-pick');
  if (!box) return;
  const buttons = [...box.querySelectorAll('button[data-n]')];
  const sync = () => {
    for (const b of buttons) b.classList.toggle('on', Number(b.dataset.n) === S.playerCount);
  };
  for (const b of buttons) {
    b.addEventListener('click', () => {
      S.playerCount = clampCount(b.dataset.n);
      sync();
    });
  }
  sync();
}

function boot() {
  $('in-name').value = store.get('tiaoqi-name');
  bindCountPicker();
  $('btn-create').addEventListener('click', createRoom);
  $('btn-join').addEventListener('click', joinRoom);
  $('btn-start').addEventListener('click', startGame);
  $('btn-leave').addEventListener('click', () => resetAll());
  $('btn-menu').addEventListener('click', () => {
    // 角色说明按 ui.js 约定区分房主 / 观战 / 普通加入者
    const role = S.role === 'host' ? 'host' : isPlayerSeat(S.seat) ? 'guest' : 'spectator';
    UI.showMenu({ code: S.code, role, onQuit: () => resetAll() });
  });
  $('in-code').addEventListener('input', (e) => {
    e.target.value = normalizeCode(e.target.value);
  });
  $('in-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });
  $('in-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createRoom();
  });
  window.addEventListener('beforeunload', () => {
    try { S.host && S.host.closeAll(); } catch (_) { /* ignore */ }
    try { S.guest && S.guest.close(); } catch (_) { /* ignore */ }
  });
  UI.bindUI();
  UI.setChatSender(sendChat);
  UI.renderChat([], S.name);
  UI.showScreen('home');
}

boot();
