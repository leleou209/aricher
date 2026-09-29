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

/** 记一笔。nickname 取记录那一刻的称呼，事后翻账才知道「这是谁干的事」。 */
export function logVisitorEvent(
  sql: SqlTag,
  room: string,
  nickname: string,
  kind: string,
  detail = "",
): VisitorEvent {
  ensureVisitorSchema(sql);
  const row: VisitorEvent = {
    id: crypto.randomUUID(),
    room,
    nickname: nickname.slice(0, 20),
    kind,
    detail: detail.slice(0, 300),
    ts: new Date().toISOString(),
  };
  sql`INSERT INTO visitor_events (id, room, nickname, kind, detail, ts)
      VALUES (${row.id}, ${row.room}, ${row.nickname}, ${row.kind}, ${row.detail}, ${row.ts})`;
  return row;
}

/** 一个房间的留痕，新的在前。 */
export function listVisitorEvents(
  sql: SqlTag,
  room: string,
  limit = 500,
): VisitorEvent[] {
  ensureVisitorSchema(sql);
  return sql<EventRow>`
    SELECT id, room, nickname, kind, detail, ts FROM visitor_events
    WHERE room = ${room} ORDER BY ts DESC LIMIT ${limit}`.map((r) => ({
    id: r.id,
    room: r.room,
    nickname: r.nickname,
    kind: r.kind,
    detail: r.detail,
    ts: r.ts,
  }));
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
