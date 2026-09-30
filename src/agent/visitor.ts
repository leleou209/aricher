// visitor_events：来客行为档案。
//
// ericher 的守则里写着「我做的事留痕，而且对每位来访者都明说」——
// 这张表就是那句话的落点：来客进过门、说过什么、动过哪些面板，
// 一笔一笔记下来。留痕不是偷记：客人问「你们记了我什么」时，
// visitor_log 工具能把这份账当面摊开给他看。
//
// 存储按房间分：每个来客那间（guest-<hash> DO）只有自己的账，
// 主人那间只存一张「名册」（谁来过、最近一次什么时候）——
// 集中存明细等于把所有客人的行为摆在同一间屋里，那不是留痕是聚堆。

import type { SqlTag } from "./state";

export interface VisitorEvent {
  id: string;
  room: string;
  /** 记这笔时客人报过的称呼；空串 = 还没报过 */
  nickname: string;
  /** join / message / intro / panel */
  kind: string;
  detail: string;
  ts: string;
}

interface EventRow {
  id: string;
  room: string;
  nickname: string;
  kind: string;
  detail: string;
  ts: string;
}

export interface VisitorRoom {
  room: string;
  nickname: string;
  firstSeen: string;
  lastSeen: string;
}

interface RoomRow {
  room: string;
  nickname: string;
  first_seen: string;
  last_seen: string;
}

export function ensureVisitorSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS visitor_events (
       id       TEXT PRIMARY KEY,
       room     TEXT NOT NULL,
       nickname TEXT NOT NULL DEFAULT '',
       kind     TEXT NOT NULL,
       detail   TEXT NOT NULL DEFAULT '',
       ts       TEXT NOT NULL
     )`;
  sql`CREATE INDEX IF NOT EXISTS idx_visitor_events_room ON visitor_events(room, ts)`;
  // 名册只建在主人那间（logVisitor 在主人那间是空操作，自然不会写）
  sql`CREATE TABLE IF NOT EXISTS visitor_rooms (
       room       TEXT PRIMARY KEY,
       nickname   TEXT NOT NULL DEFAULT '',
       first_seen TEXT NOT NULL,
       last_seen  TEXT NOT NULL
     )`;
}

/**
 * 块行的 kind。块 = 一行 JSON 数组装着一串事件 —— 行写入是 CF 计费的最矮墙，
 * 同一轮里的几笔留痕收成一行，行数直接省一个数量级。读取时展开，新旧混排。
 */
export const VISITOR_BATCH_KIND = "batch";

/** 构造一笔（不落库）。nickname 取记录那一刻的称呼，事后翻账才知道「这是谁干的事」。 */
export function buildVisitorEvent(
  room: string,
  nickname: string,
  kind: string,
  detail = "",
): VisitorEvent {
  return {
    id: crypto.randomUUID(),
    room,
    nickname: nickname.slice(0, 20),
    kind,
    detail: detail.slice(0, 300),
    ts: new Date().toISOString(),
  };
}

/** 落一笔散行。轮外的单笔留痕走这里 —— 进门、面板这些地方没有「轮尾」替它收口。 */
export function logVisitorEventRow(sql: SqlTag, row: VisitorEvent): void {
  ensureVisitorSchema(sql);
  sql`INSERT INTO visitor_events (id, room, nickname, kind, detail, ts)
      VALUES (${row.id}, ${row.room}, ${row.nickname}, ${row.kind}, ${row.detail}, ${row.ts})`;
}

/** 记一笔。 */
export function logVisitorEvent(
  sql: SqlTag,
  room: string,
  nickname: string,
  kind: string,
  detail = "",
): VisitorEvent {
  const row = buildVisitorEvent(room, nickname, kind, detail);
  logVisitorEventRow(sql, row);
  return row;
}

/**
 * 把一批事件收成一行落库。ts 取块内最新那笔 —— 块在时间轴上停在它最后一笔的位置。
 * 读侧见 listVisitorEvents：块行展开、新旧重排，翻账的人看不出这笔账是怎么存的。
 */
export function logVisitorEventBatch(
  sql: SqlTag,
  events: VisitorEvent[],
): void {
  if (!events.length) return;
  ensureVisitorSchema(sql);
  // 空昵称也得走占位符 —— 写成字面量 '' 会让后面的参数整体错一位
  sql`INSERT INTO visitor_events (id, room, nickname, kind, detail, ts)
      VALUES (${crypto.randomUUID()}, ${events[0].room}, ${""}, ${VISITOR_BATCH_KIND}, ${JSON.stringify(events)}, ${events[events.length - 1].ts})`;
}

/**
 * 一个房间的留痕，新的在前。
 *
 * 块行在这里展开 —— 表里怎么存是存储的事，翻出来永远是一条条看得懂的账。
 * SQL 层的 LIMIT 数的是行数（块算一行），展开后按时间重排再截到 limit 条。
 * 坏块（解析不了）整块跳过：账本上不摆一张废纸。
 */
export function listVisitorEvents(
  sql: SqlTag,
  room: string,
  limit = 500,
): VisitorEvent[] {
  ensureVisitorSchema(sql);
  const rows = sql<EventRow>`
    SELECT id, room, nickname, kind, detail, ts FROM visitor_events
    WHERE room = ${room} ORDER BY ts DESC LIMIT ${limit}`;
  const events: VisitorEvent[] = [];
  for (const r of rows) {
    if (r.kind === VISITOR_BATCH_KIND) {
      try {
        const batch = JSON.parse(r.detail) as VisitorEvent[];
        if (Array.isArray(batch)) events.push(...batch);
      } catch {
        // 坏块跳过 —— 少看一笔，好过整个翻账炸掉
      }
      continue;
    }
    events.push({
      id: r.id,
      room: r.room,
      nickname: r.nickname,
      kind: r.kind,
      detail: r.detail,
      ts: r.ts,
    });
  }
  return events
    .sort((a, b) => (a.ts < b.ts ? 1 : b.ts < a.ts ? -1 : 0))
    .slice(0, limit);
}

/** 来客名册：报过新称呼就更新，每次报到顺手刷新 last_seen。 */
export function registerVisitorRoom(
  sql: SqlTag,
  room: string,
  nickname: string,
): void {
  ensureVisitorSchema(sql);
  const now = new Date().toISOString();
  sql`INSERT INTO visitor_rooms (room, nickname, first_seen, last_seen)
      VALUES (${room}, ${nickname.slice(0, 20)}, ${now}, ${now})
      ON CONFLICT(room) DO UPDATE SET
        last_seen = ${now},
        nickname = CASE WHEN ${nickname} != '' THEN ${nickname.slice(0, 20)}
                        ELSE visitor_rooms.nickname END`;
}

export function listVisitorRooms(sql: SqlTag): VisitorRoom[] {
  ensureVisitorSchema(sql);
  return sql<RoomRow>`
    SELECT room, nickname, first_seen, last_seen FROM visitor_rooms
    ORDER BY last_seen DESC`.map((r) => ({
    room: r.room,
    nickname: r.nickname,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  }));
}
