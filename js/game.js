// 中国跳棋对局状态机（纯逻辑，不依赖 DOM / 网络）
// 由房主（host）单方面运行：校验走子/连跳、判入营获胜、维护悔棋求和，其他人只提交动作、收视图。

const V = new URL(import.meta.url).search; // 跟随 index.html 的 ?v= 做缓存穿透
const R = await import('./rules.js' + V);

export const PHASE = { LOBBY: 'lobby', PLAY: 'play', OVER: 'over' };

/** 座位 → 执方：0 号位执红先行（下方营），1 号位执蓝（上方营）；席位 < 0 为观战 */
export const sideOfSeat = (seat) => (seat === 0 ? R.RED : seat === 1 ? R.BLUE : null);
export const seatOfSide = (side) => (side === R.RED ? 0 : 1);

const REASON_TEXT = {
  home: '全部入营',
  resign: '认输',
  draw: '双方同意',
};

export class Game {
  /** players: [{ name, connected }]，固定两个对局座位 */
  constructor(players = []) {
    this.players = [0, 1].map((seat) => ({
      seat,
      side: sideOfSeat(seat),
      name: (players[seat] && players[seat].name) || '玩家' + (seat + 1),
      connected: !!(players[seat] && players[seat].connected !== false),
    }));
    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.resetPublic();
  }

  resetPublic() {
    this.board = R.initialBoard();
    this.turn = R.RED;
    this.history = []; // [{ ply, side, from, path, notation, jumps }]
    this.lastMove = null; // { from, path }
    this.result = null;
    this.offers = { undo: null, draw: null }; // 待回应的请求：对方座位号
    this.startedAt = 0;
  }

  /** 开新一局（红先） */
  start() {
    this.resetPublic();
    this.phase = PHASE.PLAY;
    this.round++;
    this.startedAt = Date.now();
    return this;
  }

  get plyCount() {
    return this.history.length;
  }

  player(seat) {
    return this.players.find((p) => p.seat === seat) || null;
  }

  /** 统一动作入口 */
  action(seat, act) {
    if (!act || typeof act !== 'object') throw new Error('无效操作');
    switch (act.type) {
      case 'move':
        return this.move(seat, Number(act.from), Array.isArray(act.path) ? act.path.map(Number) : null);
      case 'resign':
        return this.resign(seat);
      case 'undo':
        return this.requestUndo(seat);
      case 'undoReply':
        return this.replyUndo(seat, !!act.accept);
      case 'draw':
        return this.offerDraw(seat);
      case 'drawReply':
        return this.replyDraw(seat, !!act.accept);
      default:
        throw new Error('无效操作');
    }
  }

  /* ---------------- 走子 ---------------- */

  move(seat, from, path) {
    if (this.phase !== PHASE.PLAY) throw new Error('对局还没开始或已经结束');
    const side = sideOfSeat(seat);
    if (!side) throw new Error('观战不能走棋');
    if (this.offers.undo !== null || this.offers.draw !== null) throw new Error('先处理还没答复的悔棋 / 求和请求');
    if (side !== this.turn) throw new Error('还没轮到你走棋');
    if (!Number.isInteger(from) || from < 0 || from >= R.SIZE) throw new Error('走法无效');
    if (!this.board[from]) throw new Error('这里没有棋子');
    if (!path) throw new Error('走法无效');

    const dest = path[path.length - 1];
    if (!R.isLegalMove(this.board, from, path)) {
      if (dest !== undefined && this.board[dest]) throw new Error('落点已经有棋子了');
      throw new Error('这步棋走不通（只能走一步，或者连续跳）');
    }

    const notation = R.moveNotation(path);
    const { board } = R.applyMove(this.board, from, path);
    this.board = board;
    this.history.push({
      ply: this.history.length + 1,
      side,
      from,
      path: path.slice(),
      notation,
      jumps: R.jumpCount(path),
    });
    this.lastMove = { from, path: path.slice() };
    this.offers = { undo: null, draw: null };
    this.turn = R.other(side);

    const win = R.detectWin(this.board);
    if (win && win.side === side) {
      this.finish(side, 'home');
      return { ok: true, over: true, notation };
    }
    return { ok: true, over: false, notation };
  }

  /* ---------------- 认输 / 和棋 ---------------- */

  resign(seat) {
    if (this.phase !== PHASE.PLAY) throw new Error('对局已经结束');
    const side = sideOfSeat(seat);
    if (!side) throw new Error('观战不能认输');
    this.finish(R.other(side), 'resign');
    return { ok: true, over: true };
  }

  offerDraw(seat) {
    if (this.phase !== PHASE.PLAY) throw new Error('对局已经结束');
    if (!sideOfSeat(seat)) throw new Error('观战不能求和');
    if (this.offers.draw !== null) throw new Error('已经有一个求和请求在等回应');
    if (this.offers.undo !== null) throw new Error('先处理悔棋请求');
    this.offers.draw = seat;
    return { ok: true };
  }

  replyDraw(seat, accept) {
    const by = this.offers.draw;
    if (by === null) throw new Error('没有待回应的求和请求');
    if (seat === by) throw new Error('不能自己答应自己');
    if (!sideOfSeat(seat)) throw new Error('观战不能回应求和');
    this.offers.draw = null;
    if (accept) {
      this.finish(null, 'draw');
      return { ok: true, over: true, accepted: true };
    }
    return { ok: true, over: false, accepted: false };
  }

  /* ---------------- 悔棋（需要对方同意） ---------------- */

  /** 这个座位现在能不能请求悔棋：自己走过棋、没人抢着申请 */
  canRequestUndo(seat) {
    const side = sideOfSeat(seat);
    if (!side || this.phase !== PHASE.PLAY) return false;
    if (this.offers.undo !== null || this.offers.draw !== null) return false;
    return this.history.some((h) => h.side === side);
  }

  requestUndo(seat) {
    if (this.phase !== PHASE.PLAY) throw new Error('对局已经结束');
    const side = sideOfSeat(seat);
    if (!side) throw new Error('观战不能悔棋');
    if (this.offers.undo !== null) throw new Error('已经有一个悔棋请求在等回应');
    if (this.offers.draw !== null) throw new Error('先处理求和请求');
    if (!this.history.some((h) => h.side === side)) throw new Error('你还没走过棋，没有可悔的');
    this.offers.undo = seat;
    return { ok: true };
  }

  replyUndo(seat, accept) {
    const by = this.offers.undo;
    if (by === null) throw new Error('没有待回应的悔棋请求');
    if (seat === by) throw new Error('不能自己答应自己');
    if (!sideOfSeat(seat)) throw new Error('观战不能回应悔棋');
    this.offers.undo = null;
    if (!accept) return { ok: true, over: false, accepted: false };

    // 撤回到「自己上一步之前」：刚走完（对方还没应）只退 1 手，对方已应则退 2 手
    const want = sideOfSeat(by);
    let popped = 0;
    while (this.history.length && popped < 2) {
      const last = this.history[this.history.length - 1];
      this.popPly();
      popped++;
      if (last.side === want && this.turn === want) break;
    }
    return { ok: true, over: false, accepted: true, popped };
  }

  popPly() {
    const last = this.history.pop();
    if (!last) return null;
    const dest = last.path[last.path.length - 1];
    this.board[last.from] = last.side;
    this.board[dest] = null;
    this.turn = last.side;
    this.lastMove = this.history.length
      ? { from: this.history[this.history.length - 1].from, path: this.history[this.history.length - 1].path.slice() }
      : null;
    return last;
  }

  /* ---------------- 结束 ---------------- */

  finish(winnerSide, reason) {
    this.phase = PHASE.OVER;
    this.offers = { undo: null, draw: null };
    const text = REASON_TEXT[reason] || reason;
    this.result = {
      winner: winnerSide || null,
      reason,
      text: winnerSide ? `${R.SIDE_NAME[winnerSide]}方胜（${text}）` : `和棋（${text}）`,
      plies: this.history.length,
    };
  }

  /* ---------------- 视图 ---------------- */

  /**
   * 某人的可见视图。seat = -1 表示观战（跳棋没有暗牌，信息完全公开）。
   */
  view(seat = -1) {
    const spectator = !sideOfSeat(seat);
    return {
      phase: this.phase,
      round: this.round,
      seat: spectator ? -1 : seat,
      spectator,
      mySide: spectator ? null : sideOfSeat(seat),
      turn: this.turn,
      board: this.board.slice(),
      players: this.players.map((p) => ({ ...p })),
      moves: this.history.map((h) => ({
        ply: h.ply,
        side: h.side,
        from: h.from,
        path: h.path.slice(),
        notation: h.notation,
        jumps: h.jumps,
      })),
      lastMove: this.lastMove ? { from: this.lastMove.from, path: this.lastMove.path.slice() } : null,
      goalCount: { r: R.inGoal(this.board, R.RED), b: R.inGoal(this.board, R.BLUE) },
      offers: { ...this.offers },
      canUndo: this.canRequestUndo(seat),
      result: this.result,
      startedAt: this.startedAt,
    };
  }
}
