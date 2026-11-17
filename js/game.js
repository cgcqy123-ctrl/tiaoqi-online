// 中国跳棋对局状态机（2-6 人，纯逻辑，不依赖 DOM / 网络）
// 由房主（host）单方面运行：校验走子/连跳、判入营获胜、维护悔棋求和，其他人只提交动作、收视图。

const V = new URL(import.meta.url).search; // 跟随 index.html 的 ?v= 做缓存穿透
const R = await import('./rules.js' + V);

export const PHASE = { LOBBY: 'lobby', PLAY: 'play', OVER: 'over' };

export class Game {
  /** players: [{ name, connected }]，每人大约 10 子；count = 2..6 */
  constructor(players = [], count = 2) {
    const n = R.PLAYER_COUNTS.includes(Number(count)) ? Number(count) : 2;
    this.count = n;
    this.camps = R.campsForCount(n); // 座位 0..n-1 对应的营下标
    this.players = Array.from({ length: n }, (_, seat) => ({
      seat,
      name: (players[seat] && players[seat].name) || '玩家' + (seat + 1),
      connected: !!(players[seat] && players[seat].connected !== false),
    }));
    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.resetPublic();
  }

  resetPublic() {
    this.camps = R.campsForCount(this.count);
    this.board = R.initialBoard(this.count);
    this.turn = 0;
    this.history = []; // [{ ply, seat, from, path, notation, jumps }]
    this.lastMove = null; // { from, path }
    this.result = null;
    this.offers = { undo: null, draw: null }; // undo: 座位号；draw: { by, accepts[] }
    this.startedAt = 0;
  }

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

  name(seat) {
    const p = this.player(seat);
    return p ? p.name : '玩家';
  }

  /** 下一个轮到谁 */
  nextSeat(seat) {
    return (seat + 1) % this.count;
  }

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
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.count) throw new Error('观战不能走棋');
    if (this.offers.undo !== null || this.offers.draw !== null) throw new Error('先处理还没答复的悔棋 / 求和请求');
    if (seat !== this.turn) throw new Error('还没轮到你走棋');
    if (!Number.isInteger(from) || from < 0 || from >= R.SIZE) throw new Error('走法无效');
    if (this.board[from] === null) throw new Error('这里没有棋子');
    if (this.board[from] !== seat) throw new Error('那不是你的棋子');
    if (!path) throw new Error('走法无效');

    const dest = path[path.length - 1];
    if (!R.isLegalMove(this.board, from, path)) {
      if (dest !== undefined && this.board[dest] !== null) throw new Error('落点已经有棋子了');
      throw new Error('这步棋走不通（只能走一步，或者连续跳）');
    }

    const notation = R.moveNotation(path);
    const { board } = R.applyMove(this.board, from, path);
    this.board = board;
    this.history.push({
      ply: this.history.length + 1,
      seat,
      from,
      path: path.slice(),
      notation,
      jumps: R.jumpCount(path),
    });
    this.lastMove = { from, path: path.slice() };
    this.offers = { undo: null, draw: null };
    this.turn = this.nextSeat(seat);

    const win = R.detectWin(this.board, this.count);
    if (win >= 0 && win === seat) {
      this.finish(seat, 'home');
      return { ok: true, over: true, notation };
    }
    return { ok: true, over: false, notation };
  }

  /* ---------------- 认输 ---------------- */

  /** 两人局：对方直接获胜；多人局：认输者退出，本局结束（不分胜负） */
  resign(seat) {
    if (this.phase !== PHASE.PLAY) throw new Error('对局已经结束');
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.count) throw new Error('观战不能认输');
    if (this.count === 2) this.finish((seat + 1) % 2, 'resign');
    else this.finish(-1, 'resign', { resigned: seat });
    return { ok: true, over: true };
  }

  /* ---------------- 求和（多人局需要所有其他玩家同意） ---------------- */

  offerDraw(seat) {
    if (this.phase !== PHASE.PLAY) throw new Error('对局已经结束');
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.count) throw new Error('观战不能求和');
    if (this.offers.draw !== null) throw new Error('已经有一个求和请求在等回应');
    if (this.offers.undo !== null) throw new Error('先处理悔棋请求');
    this.offers.draw = { by: seat, accepts: [] };
    return { ok: true };
  }

  replyDraw(seat, accept) {
    const d = this.offers.draw;
    if (d === null) throw new Error('没有待回应的求和请求');
    if (seat === d.by) throw new Error('不能自己答应自己');
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.count) throw new Error('观战不能回应求和');
    if (!accept) {
      this.offers.draw = null;
      return { ok: true, over: false, accepted: false, rejected: true };
    }
    if (!d.accepts.includes(seat)) d.accepts.push(seat);
    const need = this.count - 1;
    if (d.accepts.length >= need) {
      this.finish(-1, 'draw');
      return { ok: true, over: true, accepted: true };
    }
    return { ok: true, over: false, accepted: true, waiting: need - d.accepts.length };
  }

  /* ---------------- 悔棋（需要其他玩家同意） ---------------- */

  canRequestUndo(seat) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.count) return false;
    if (this.phase !== PHASE.PLAY) return false;
    if (this.offers.undo !== null || this.offers.draw !== null) return false;
    return this.history.some((h) => h.seat === seat);
  }

  requestUndo(seat) {
    if (this.phase !== PHASE.PLAY) throw new Error('对局已经结束');
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.count) throw new Error('观战不能悔棋');
    if (this.offers.undo !== null) throw new Error('已经有一个悔棋请求在等回应');
    if (this.offers.draw !== null) throw new Error('先处理求和请求');
    if (!this.history.some((h) => h.seat === seat)) throw new Error('你还没走过棋，没有可悔的');
    this.offers.undo = seat;
    return { ok: true };
  }

  replyUndo(seat, accept) {
    const by = this.offers.undo;
    if (by === null) throw new Error('没有待回应的悔棋请求');
    if (seat === by) throw new Error('不能自己答应自己');
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.count) throw new Error('观战不能回应悔棋');
    this.offers.undo = null;
    if (!accept) return { ok: true, over: false, accepted: false };

    // 一直退到「请求方上一步之前」：如果中间已经有 N 个其他玩家走过，就一起退掉
    let popped = 0;
    while (this.history.length) {
      const last = this.history[this.history.length - 1];
      this.popPly();
      popped++;
      if (last.seat === by && this.turn === by) break;
    }
    return { ok: true, over: false, accepted: true, popped };
  }

  popPly() {
    const last = this.history.pop();
    if (!last) return null;
    const dest = last.path[last.path.length - 1];
    this.board[last.from] = last.seat;
    this.board[dest] = null;
    this.turn = last.seat;
    this.lastMove = this.history.length
      ? { from: this.history[this.history.length - 1].from, path: this.history[this.history.length - 1].path.slice() }
      : null;
    return last;
  }

  /* ---------------- 结束 ---------------- */

  finish(winnerSeat, reason, extra = {}) {
    this.phase = PHASE.OVER;
    this.offers = { undo: null, draw: null };
    const winner = Number.isInteger(winnerSeat) && winnerSeat >= 0 ? winnerSeat : -1;
    let text;
    if (reason === 'home') text = this.name(winner) + ' 全部入营，获胜';
    else if (reason === 'draw') text = '和棋（全部玩家同意）';
    else if (reason === 'resign') {
      text = winner >= 0
        ? this.name(winner) + ' 胜（对方认输）'
        : this.name(extra.resigned) + ' 认输，本局结束';
    } else text = reason;
    this.result = {
      winner,
      reason,
      text,
      plies: this.history.length,
      resigned: Number.isInteger(extra.resigned) ? extra.resigned : undefined,
    };
  }

  /* ---------------- 视图 ---------------- */

  /** 某人的可见视图。seat = -1 表示观战。 */
  view(seat = -1) {
    const spectator = !Number.isInteger(seat) || seat < 0 || seat >= this.count;
    const d = this.offers.draw;
    return {
      phase: this.phase,
      round: this.round,
      count: this.count,
      camps: this.camps,
      seat: spectator ? -1 : seat,
      spectator,
      turn: this.turn,
      board: this.board.slice(),
      players: this.players.map((p) => ({ ...p })),
      moves: this.history.map((h) => ({
        ply: h.ply,
        seat: h.seat,
        from: h.from,
        path: h.path.slice(),
        notation: h.notation,
        jumps: h.jumps,
      })),
      lastMove: this.lastMove ? { from: this.lastMove.from, path: this.lastMove.path.slice() } : null,
      goalCount: Array.from({ length: this.count }, (_, s) => R.inGoal(this.board, s, this.count)),
      offers: {
        undo: this.offers.undo,
        draw: d ? { by: d.by, accepts: d.accepts.slice() } : null,
      },
      canUndo: this.canRequestUndo(seat),
      result: this.result,
      startedAt: this.startedAt,
    };
  }
}
