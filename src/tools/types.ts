// 工具运行时上下文。工具是纯函数，所有副作用通过这里注入，便于单独测试。

import type { Note, NoteInput, NoteMeta } from "../agent/noteStore";
import type { GuestTypeInfo } from "../agent/guestTypes";
import type { Reminder } from "../agent/reminderStore";
import type { RecallHit, SessionMeta } from "../agent/sessionStore";
import type { ChatState, MemEntry, SqlTag } from "../agent/state";

export interface ToolCtx {
  env: Env;
  sql: SqlTag;
  /** 本间屋子的 DO 名（default / guest-<hash>）。留痕工具靠它认自己的账本 */
  room: string;
  /** 来客那一间：只给「对外」的工具，主人自己的记忆/邮件/文件不给他碰 */
  guest: boolean;
  /**
   * 来客登记的那一档（多档来客类型，形状同 agent/guestTypes.ts 的 GuestTypeInfo），
   * 不含密码。缺省（普通来客票 / 老 state）按全开处理；perm 开着就注册对应工具组，
   * 关了就不注册 —— 工具没到手，比「到手了再拦」可靠。
   */
  guestType?: GuestTypeInfo;
  /** 当前 state 快照（每次对话开始时读取一次） */
  state: ChatState;
  /** 合并写入 state（内部会 setState 完整对象） */
  patchState(patch: Partial<ChatState>): void;
  /** 向所有连接广播一条非聊天提示；无连接时静默 */
  notify(text: string): void;
  /** 把记忆送进 Vectorize（经 queue 重试，失败不阻塞对话） */
  enqueueVector(entry: {
    id: string;
    content: string;
    type: string;
    shelf: string;
    tags: string[];
  }): void;
  /** 用维护模型跑一次单轮补全，失败返回空串 */
  maintenance(system: string, user: string): Promise<string>;
  /** 会话整理：压缩历史 + 萃取洞察 */
  organize(): Promise<string>;
  /** 最近对话的纯文本视图，用于反思 / 整理 */
  transcript(limit?: number): string;
  /** 最近消息的 id + 摘要，反馈类工具靠它定位某条消息 */
  recentMessages(
    limit?: number,
  ): Array<{ id: string; role: string; text: string }>;
  /** 定一条提醒：写表 + 交给 SDK 调度。时间非法或已过去时抛错 */
  scheduleReminder(input: {
    what: string;
    at: string;
    every: string;
    urgent: boolean;
    /** 到点在哪儿说：same = 回原来那一场（默认），new = 另开一场 */
    mode?: "same" | "new";
    /** mode = new 时那一场的名字 */
    title?: string;
  }): Promise<Reminder>;
  /** 我自己开一场新会话说一件事：建场 + 把话写进去 + 标成「他还没看过」 */
  openSession(input: { content: string; title?: string }): Promise<SessionMeta>;
  /** 还没触发的提醒，按时间先后 */
  listReminders(): Reminder[];
  /** 取消一条待触发提醒，同时撤掉 SDK 那边的调度 */
  cancelReminder(id: string): boolean;
  /** 跨会话回忆：按关键词在全部历史会话里搜，返回命中片段 */
  recall(query: string): RecallHit[];
  /** 笔记本：列表（只带标题、标签和一小段开头，不吐正文） */
  listNotes(opts?: { q?: string; tag?: string }): NoteMeta[];
  /** 笔记本：读一整篇 */
  readNote(id: string): Note | null;
  /** 笔记本：新建或改写。by 由这层注入（一律记成我写的），工具不用管 */
  saveNote(input: Omit<NoteInput, "by">): Note;
  /** 笔记本：删掉一篇（连它的历史版本一起） */
  deleteNote(id: string): boolean;
  /** 他此刻翻着的那一篇。他嘴里说的「这里」「这篇」多半指它 */
  focusedNote(): Note | null;
  /**
   * 这一轮在替哪一场回想。
   * 只有「休息态回想」那一轮会填：那时写下的会话记忆该挂到被回想的那一场上，
   * 而不是挂到「屏幕上正开着的这一场」—— 回想别的旧会话时，屏幕上多半还开着另一场。
   */
  recapSessionId?: string;
  /**
   * 这一趟回想的幂等键（`${sessionId}:${起点}`）。带它写下的记忆，同键重写会被
   * 写入层跳过 —— 回想写了记忆却没推进游标时（写回那一步失败），下一趟重跑
   * 不会把同一段再记一遍。
   */
  recapDedupe?: string;
  /**
   * 轮内检索缓存：一轮里同一个词翻第二遍记忆库，不该再花一遍向量查询的钱。
   * 谁发这个 ctx 谁管生命周期（一轮一清）；写记忆的动作必须当场清它 ——
   * 刚记下的话当场就该搜得到。
   */
  recallCache?: Map<string, MemEntry[]>;
}

/** 统一的工具返回：字符串直接作为 tool result 交给模型 */
export type ToolResult = string;
