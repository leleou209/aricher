/**
 * 来客行为档案（visitor_events）测试。
 *
 * 验的都是「留痕靠不靠得住」这件小事：
 * - 明细按房间隔离（翻不到别人那间的账 —— 物理隔离在表层面也一样成立）
 * - detail / nickname 截断，别让一条长留言把账本撑爆
 * - 名册的 upsert 语义：报了新称呼就更新，没报就保留旧的
 *
 * 用最小假 SQL 引擎，只认得 visitor.ts 会发的那几条语句。
 * 时间走的是手动时钟 —— 排序语义只有把钟拨开才验得出来。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import {
  logVisitorEvent,
  listVisitorEvents,
  registerVisitorRoom,
  listVisitorRooms,
} from "../src/agent/visitor";
import type { SqlTag } from "../src/agent/state";

/** 手动时钟：测试里拨一下，假库写入的时间戳就跟着走（visitor.ts 自己取真时钟，假库盖写）。 */
function fakeDb(clock: { now: string }) {
  const events: Record<string, string>[] = []; // 每行一个字段映射
  const rooms = new Map<
    string,
    { nickname: string; first_seen: string; last_seen: string }
  >();

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table") || sql.startsWith("create index"))
      return [] as T[];

    if (sql.startsWith("insert into visitor_events")) {
      const [id, room, nickname, kind, detail] = values as [
        string,
        string,
        string,
        string,
        string,
      ];
      events.push({
        id,
        room,
        nickname,
        kind,
        detail,
        ts: clock.now,
      });
      return [] as T[];
    }

    if (sql.startsWith("select id, room, nickname, kind, detail, ts")) {
      const [room, limit] = values as [string, number];
      return events
        .filter((e) => e.room === room)
        .sort((a, b) => (a.ts < b.ts ? 1 : -1))
        .slice(0, limit) as T[];
    }

    if (sql.startsWith("insert into visitor_rooms")) {
      // 语句里的 values 顺序：四个 INSERT 值 + ON CONFLICT 更新用的 (last_seen, nickname)
      const [room, nickname, , , , nickname2] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const prev = rooms.get(room);
      rooms.set(room, {
        nickname: nickname2 !== "" ? nickname2 : (prev?.nickname ?? nickname),
        first_seen: prev?.first_seen ?? clock.now,
        last_seen: clock.now,
      });
      return [] as T[];
    }

    if (sql.startsWith("select room, nickname, first_seen, last_seen")) {
      return [...rooms.entries()]
        .sort((a, b) => (a[1].last_seen < b[1].last_seen ? 1 : -1))
        .map(([room, v]) => ({ room, ...v })) as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return { db };
}

describe("visitor_events", () => {
  it("记一笔留一条，翻回来对得上", () => {
    const clock = { now: "2026-01-01T00:00:00.000Z" };
    const { db } = fakeDb(clock);
    logVisitorEvent(db, "guest-aabb", "小张", "join", "role=user");
    const list = listVisitorEvents(db, "guest-aabb", 500);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      room: "guest-aabb",
      nickname: "小张",
      kind: "join",
      detail: "role=user",
    });
    expect(list[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // 落库时间是真的时钟，不是假钟
  });

  it("明细按房间隔离：别家那间的账一个字都翻不到", () => {
    const clock = { now: "2026-01-01T00:00:00.000Z" };
    const { db } = fakeDb(clock);
    logVisitorEvent(db, "guest-aabb", "小张", "message", "你好");
    logVisitorEvent(db, "guest-ccdd", "小李", "message", "Hi");
    expect(
      listVisitorEvents(db, "guest-aabb", 500).map((e) => e.detail),
    ).toEqual(["你好"]);
    expect(
      listVisitorEvents(db, "guest-ccdd", 500).map((e) => e.detail),
    ).toEqual(["Hi"]);
  });

  it("detail 截到 300 字、nickname 截到 20 字", () => {
    const clock = { now: "2026-01-01T00:00:00.000Z" };
    const { db } = fakeDb(clock);
    logVisitorEvent(
      db,
      "guest-aabb",
      "x".repeat(30),
      "message",
      "y".repeat(400),
    );
    const [row] = listVisitorEvents(db, "guest-aabb", 500);
    expect(row.detail.length).toBe(300);
    expect(row.nickname.length).toBe(20);
  });

  it("新的在前，limit 生效", () => {
    const clock = { now: "2026-01-01T00:00:00.000Z" };
    const { db } = fakeDb(clock);
    for (let i = 0; i < 5; i++) {
      logVisitorEvent(db, "guest-aabb", "", "panel", `第${i}笔`);
      // 拨一秒钟，保证 ts 互不相同（同毫秒的排序不归这套逻辑管）
      clock.now = new Date(Date.parse(clock.now) + 1000).toISOString();
    }
    const list = listVisitorEvents(db, "guest-aabb", 3);
    expect(list).toHaveLength(3);
    expect(list[0].detail).toBe("第4笔");
  });

  it("名册：报了新称呼就更新，没报（空串）保留旧称呼，first_seen 不动", () => {
    const clock = { now: "2026-01-01T00:00:00.000Z" };
    const { db } = fakeDb(clock);
    registerVisitorRoom(db, "guest-aabb", "小张");
    const firstSeen = listVisitorRooms(db)[0].firstSeen;

    clock.now = "2026-01-02T00:00:00.000Z";
    registerVisitorRoom(db, "guest-aabb", ""); // 隔天又来，还没报名
    let rooms = listVisitorRooms(db);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].nickname).toBe("小张"); // 空称呼不覆盖
    expect(rooms[0].firstSeen).toBe(firstSeen);
    expect(rooms[0].lastSeen).toBe(clock.now);

    registerVisitorRoom(db, "guest-aabb", "张三丰");
    rooms = listVisitorRooms(db);
    expect(rooms[0].nickname).toBe("张三丰");
  });

  it("名册按最近到访排序，谁后来谁在前", () => {
    const clock = { now: "2026-01-01T00:00:00.000Z" };
    const { db } = fakeDb(clock);
    registerVisitorRoom(db, "guest-aabb", "先来的");
    clock.now = "2026-01-02T00:00:00.000Z";
    registerVisitorRoom(db, "guest-ccdd", "后来的");
    expect(listVisitorRooms(db).map((r) => r.room)).toEqual([
      "guest-ccdd",
      "guest-aabb",
    ]);
  });
});
