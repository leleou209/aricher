// 提醒：ericher 的「主动」能力——到点自己回来找你。
//
// 时间调度本身交给 Agents SDK 的 schedule()：它把任务落在 SQLite 里，
// DO 被驱逐后仍会在正确时刻唤醒，不需要自己轮询。
// 这张表只记业务语义：提醒的是什么、属于哪一场会话、SDK 那边的 schedule id。
//
// 和 task 的分工要分清：task 是「要做什么」（没有时间维度），
// remind 是「什么时候想起它」。混在一起会让两者都变模糊。

import type { SqlTag } from "./state";

export type ReminderStatus = "pending" | "done" | "cancelled";

export interface Reminder {
  id: string;
  /** 约定这条提醒时所在的会话；到点后那句话也回到那一场 */
  sessionId: string;
  /** 到点要提醒的事，一句自然语言 */
  what: string;
  /** 首次触发时刻（ISO 8601，带时区偏移） */
  at: string;
  /** 非空表示重复提醒，值为 cron 表达式；空串表示只提醒一次 */
  every: string;
  /** SDK schedule 的 id，取消时用它 cancelSchedule */
  scheduleId: string;
  status: ReminderStatus;
  created: string;
  /** 最后一次触发时间；空串表示还没触发过 */
  firedAt: string;
  /**
   * 必须叫醒。默认是假的 —— 安静时段里的一次性提醒会被按到早上，
   * 但有些事不能等（凌晨的药、三点开抢的票），那种要他明说一声。
   * 这不是「重要程度」，是「能不能等」：重要的事明天早上说通常也来得及。
   */
  urgent: boolean;
  /**
   * 到点这句话落在哪儿。
   *
   * same = 回到当初约定它的那一场（提醒的本分：他让我到点提他一句）。
   * new  = 另开一场说（定时会话：这件事值得单独立成一场，他得空再进去看，
   *        而且以后还翻得到）。两种走的是同一条调度 —— 差别只在投递的那一步，
   *        所以共用这张表：安静时段、取消、自愈这些都不用重写一遍。
   */
  mode: "same" | "new";
  /** mode = new 时那一场的名字（会话列表里他扫一眼就知道为了什么开的）；别的场合是空串 */
  title: string;
}

/** 单条提醒的条数上限：提醒是「我们约好的事」，不该变成推送流水线 */
export const REMINDER_CAP = 50;

interface Row {
  id: string;
  session_id: string;
  what: string;
  at: string;
  every: string;
  schedule_id: string;
  status: string;
  created: string;
  fired_at: string;
  urgent: number;
  mode: string;
  title: string;
}

function toReminder(r: Row): Reminder {
  return {
    id: r.id,
    sessionId: r.session_id,
    what: r.what,
    at: r.at,
    every: r.every,
    scheduleId: r.schedule_id,
    status: r.status as ReminderStatus,
    created: r.created,
    firedAt: r.fired_at,
    urgent: !!r.urgent,
    mode: r.mode === "new" ? "new" : "same",
    title: r.title,
  };
}

export function ensureReminderSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS reminders (
       id          TEXT PRIMARY KEY,
       session_id  TEXT NOT NULL,
       what        TEXT NOT NULL,
       at          TEXT NOT NULL,
       every       TEXT NOT NULL DEFAULT '',
       schedule_id TEXT NOT NULL DEFAULT '',
       status      TEXT NOT NULL DEFAULT 'pending',
       created     TEXT NOT NULL,
       fired_at    TEXT NOT NULL DEFAULT '',
       urgent      INTEGER NOT NULL DEFAULT 0,
       mode        TEXT NOT NULL DEFAULT 'same',
       title       TEXT NOT NULL DEFAULT ''
     )`;
  sql`CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status, at)`;
  // 老表补列：create table if not exists 不会给已存在的表加列
  try {
    sql`ALTER TABLE reminders ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0`;
  } catch {
    // 列已存在
  }
  try {
    sql`ALTER TABLE reminders ADD COLUMN mode TEXT NOT NULL DEFAULT 'same'`;
  } catch {
    // 列已存在
  }
  try {
    sql`ALTER TABLE reminders ADD COLUMN title TEXT NOT NULL DEFAULT ''`;
  } catch {
    // 列已存在
  }
}

export function newReminderId(): string {
  return crypto.randomUUID();
}

export function insertReminder(
  sql: SqlTag,
  r: {
    id: string;
    sessionId: string;
    what: string;
    at: string;
    every: string;
    scheduleId: string;
    created: string;
    urgent: boolean;
    mode: "same" | "new";
    title: string;
  },
): void {
  sql`INSERT INTO reminders (id, session_id, what, at, every, schedule_id, status, created, fired_at, urgent, mode, title)
     VALUES (${r.id}, ${r.sessionId}, ${r.what}, ${r.at}, ${r.every}, ${r.scheduleId}, 'pending', ${r.created}, '', ${r.urgent ? 1 : 0}, ${r.mode}, ${r.title})`;
}

export function getReminder(sql: SqlTag, id: string): Reminder | null {
  const rows = sql<Row>`SELECT id, session_id, what, at, every, schedule_id, status, created, fired_at, urgent, mode, title
       FROM reminders WHERE id = ${id}`;
  return rows.length ? toReminder(rows[0]) : null;
}

/** 待触发的提醒，按时间先后。重复提醒触发过也还在这里（它还没结束）。 */
export function listPendingReminders(sql: SqlTag): Reminder[] {
  const rows = sql<Row>`SELECT id, session_id, what, at, every, schedule_id, status, created, fired_at, urgent, mode, title
       FROM reminders WHERE status = 'pending' ORDER BY at ASC`;
  return rows.map(toReminder);
}

/** 全部提醒（含已触发/已取消），给设置面板看历史 */
export function listAllReminders(sql: SqlTag, limit = 200): Reminder[] {
  const rows = sql<Row>`SELECT id, session_id, what, at, every, schedule_id, status, created, fired_at, urgent, mode, title
       FROM reminders ORDER BY at DESC LIMIT ${limit}`;
  return rows.map(toReminder);
}

export function countPendingReminders(sql: SqlTag): number {
  const rows = sql<{
    n: number;
  }>`SELECT COUNT(*) AS n FROM reminders WHERE status = 'pending'`;
  return rows[0]?.n ?? 0;
}

export function setReminderScheduleId(
  sql: SqlTag,
  id: string,
  scheduleId: string,
): void {
  sql`UPDATE reminders SET schedule_id = ${scheduleId} WHERE id = ${id}`;
}

/**
 * 记一次触发。一次性提醒就此结束（done），重复提醒回到待触发（只更新上次触发时间）。
 * 返回 true 表示这条提醒还活着（重复），false 表示已经走完。
 */
export function markReminderFired(
  sql: SqlTag,
  id: string,
  firedAt: string,
): boolean {
  const r = getReminder(sql, id);
  if (!r) return false;
  if (r.every) {
    sql`UPDATE reminders SET fired_at = ${firedAt} WHERE id = ${id}`;
    return true;
  }
  sql`UPDATE reminders SET fired_at = ${firedAt}, status = 'done' WHERE id = ${id}`;
  return false;
}

export function cancelReminderRow(sql: SqlTag, id: string): Reminder | null {
  const r = getReminder(sql, id);
  if (!r || r.status !== "pending") return null;
  sql`UPDATE reminders SET status = 'cancelled' WHERE id = ${id}`;
  return r;
}

export function removeReminderRow(sql: SqlTag, id: string): boolean {
  const r = getReminder(sql, id);
  if (!r) return false;
  sql`DELETE FROM reminders WHERE id = ${id}`;
  return true;
}

/** 把一条提醒写成纯文本行，工具与面板共用同一套措辞 */
export function describeReminder(r: Reminder): string {
  const when = r.every ? `${r.at} 起，每 ${r.every}` : r.at;
  // 到点在哪儿说话，是他看这一行时最需要知道的：回到原来那一场，还是另开一场
  const where =
    r.mode === "new" ? `｜另有新会话${r.title ? `「${r.title}」` : ""}` : "";
  return `${when}｜${r.what}${where}${r.urgent ? "｜必须叫醒" : ""}`;
}
