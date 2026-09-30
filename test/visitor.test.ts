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
  logVisitorEventBatch,
  listVisitorEvents,
  registerVisitorRoom,
  listVisitorRooms,
  isNewJoin,
  JOIN_DEDUPE_MS,
  VISITOR_BATCH_KIND,
  type VisitorEvent,
} from "../src/agent/visitor";
import type { SqlTag } from "../src/agent/state";

/** 假库的本来面目（测试里偶尔要绕过封装直接塞脏数据） */
type RawSql = (s: TemplateStringsArray, ...v: unknown[]) => unknown[];

/**
 * 造一笔 ts 明确的事件。块里的各笔得跟散行共用同一只假钟 ——
 * buildVisitorEvent 取的是真时钟，跟假库盖写的行 ts 不可比，排序会乱套。
 */
const ev = (detail: string, ts: string, kind = "panel"): VisitorEvent => ({
  id: "e-" + detail,
  room: "guest-aabb",
  nickname: "小张",
  kind,
  detail,
  ts,
});

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

    // isNewJoin 的查询：最近一笔「进门」。kind 是 SQL 字面量不在参数里，
    // values 只有 (room, limit) —— 认文本里的 'join' 就行。
    if (sql.startsWith("select ts from visitor_events")) {
      const [room] = values as [string];
      const hit = events
        .filter((e) => e.room === room && e.kind === "join")
        .sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
      return (hit ? [{ ts: hit.ts }] : []) as T[];
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

  return { db, events };
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

/**
 * 块状存储：一轮的几笔收成一行落库，翻账时展开如旧。
 * 行写入是 CF 计费的最矮墙 —— 块是给账本减负的，不是给账本改样的：
 * 翻出来必须还是一条条看得懂的账，新旧混排、次序、截断都跟散行时代一个样。
 */
describe("visitor_events 块状存储", () => {
  it("整块落一行，翻出来展开成一条条 —— 次序内容与散行无异", () => {
    const clock = { now: "2026-01-01T00:00:00.000Z" };
    const { db, events } = fakeDb(clock);
    logVisitorEventBatch(db, [
      ev("你好", "2026-01-01T00:00:01.000Z", "message"),
      ev("在吗", "2026-01-01T00:00:02.000Z"),
      ev("帮我看看", "2026-01-01T00:00:03.000Z"),
    ]);

    // 核心断言：三笔账在表里就是一行 —— 行数才是这道优化的账
    expect(events).toHaveLength(1);
    const list = listVisitorEvents(db, "guest-aabb", 500);
    // 新的在前 —— 跟散行时代同一个翻账方向
    expect(list.map((e) => e.detail)).toEqual(["帮我看看", "在吗", "你好"]);
    expect(list.every((e) => e.nickname === "小张")).toBe(true);
  });

  it("同一毫秒的两笔不打架：块内原序就是发生序，翻出来不许翻脸", () => {
    const clock = { now: "2026-01-01T00:00:00.000Z" };
    const { db } = fakeDb(clock);
    const same = "2026-01-01T00:00:01.000Z";
    logVisitorEventBatch(db, [ev("先发生", same), ev("后发生", same)]);

    expect(
      listVisitorEvents(db, "guest-aabb", 500).map((e) => e.detail),
    ).toEqual(["先发生", "后发生"]);
  });

  it("块与散行混排：按各笔自己的时间排序，看不出存储方式", () => {
    const clock = { now: "2026-01-01T00:00:00.000Z" };
    const { db } = fakeDb(clock);
    // 先一块（00:00:01、00:00:02 两笔）
    logVisitorEventBatch(db, [
      ev("块里前一笔", "2026-01-01T00:00:01.000Z"),
      ev("块里后一笔", "2026-01-01T00:00:02.000Z"),
    ]);
    // 再来一笔更晚的散行
    clock.now = "2026-01-01T00:00:05.000Z";
    logVisitorEvent(db, "guest-aabb", "", "message", "散行最晚");

    const list = listVisitorEvents(db, "guest-aabb", 500);
    expect(list.map((e) => e.detail)).toEqual([
      "散行最晚",
      "块里后一笔",
      "块里前一笔",
    ]);
  });

  it("坏块（解析不了的）整块跳过，别的账照翻", () => {
    const clock = { now: "2026-01-01T00:00:00.000Z" };
    const { db } = fakeDb(clock);
    logVisitorEvent(db, "guest-aabb", "", "message", "好的那一笔");
    // 直接塞一条坏块进表（模拟历史脏数据）
    (db as unknown as RawSql)`INSERT INTO visitor_events (id, room, nickname, kind, detail, ts)
      VALUES (${"bad"}, ${"guest-aabb"}, ${""}, ${VISITOR_BATCH_KIND}, ${"不是JSON"}, ${clock.now})`;

    const list = listVisitorEvents(db, "guest-aabb", 500);
    expect(list.map((e) => e.detail)).toEqual(["好的那一笔"]);
  });

  it("limit 展开后仍生效：块里十笔，只翻五笔", () => {
    const clock = { now: "2026-01-01T00:00:00.000Z" };
    const { db } = fakeDb(clock);
    logVisitorEventBatch(
      db,
      Array.from({ length: 10 }, (_, i) =>
        ev(
          `第${i}笔`,
          new Date(Date.parse(clock.now) + (i + 1) * 1000).toISOString(),
        ),
      ),
    );
    const list = listVisitorEvents(db, "guest-aabb", 5);
    expect(list).toHaveLength(5);
    // 新的在前：截掉的是最老的那几笔
    expect(list[0].detail).toBe("第9笔");
    expect(list[4].detail).toBe("第5笔");
  });

  it("空块不落库 —— 白占一行的事不做", () => {
    const clock = { now: "2026-01-01T00:00:00.000Z" };
    const { db } = fakeDb(clock);
    logVisitorEventBatch(db, []);
    expect(listVisitorEvents(db, "guest-aabb", 500)).toHaveLength(0);
  });
});

/**
 * 进门去重：CF 代理的空闲 WS 隔一阵被掐、前端自动重连，
 * 不设闸的话一个开着页面发呆的人每两三分钟就「进一次门」。
 * 进门 = 隔了一段时间的重新出现；间隔内的重连是断线，不是进门。
 */
describe("进门去重", () => {
  const t0 = "2026-01-01T00:00:00.000Z";

  it("从没记过进门 → 记（第一次来总得记账）", () => {
    const { db } = fakeDb({ now: t0 });
    expect(isNewJoin(db, "guest-aabb", Date.parse(t0))).toBe(true);
  });

  it("上一笔进门在间隔内 → 不记，那是一次断线重连", () => {
    const clock = { now: t0 };
    const { db } = fakeDb(clock);
    logVisitorEvent(db, "guest-aabb", "小张", "join", "role=user");
    const t = Date.parse(t0) + 10 * 60 * 1000;
    expect(isNewJoin(db, "guest-aabb", t)).toBe(false);
  });

  it("正好卡在阈值上 → 记（新进门的判定从间隔满那一刻起）", () => {
    const clock = { now: t0 };
    const { db } = fakeDb(clock);
    logVisitorEvent(db, "guest-aabb", "小张", "join", "role=user");
    expect(isNewJoin(db, "guest-aabb", Date.parse(t0) + JOIN_DEDUPE_MS)).toBe(
      true,
    );
  });

  it("中间隔着留言和面板也不影响：认的是上一笔「进门」，不是上一笔事件", () => {
    const clock = { now: t0 };
    const { db } = fakeDb(clock);
    logVisitorEvent(db, "guest-aabb", "小张", "join", "role=user");
    clock.now = "2026-01-01T00:05:00.000Z";
    logVisitorEvent(db, "guest-aabb", "小张", "message", "在吗");
    clock.now = "2026-01-01T00:08:00.000Z";
    logVisitorEvent(db, "guest-aabb", "小张", "panel", "翻面板");
    // 上一笔事件是 3 分钟前的面板，但上一笔进门是 8 分钟前 —— 还在间隔内，不记
    expect(
      isNewJoin(db, "guest-aabb", Date.parse("2026-01-01T00:08:00.000Z")),
    ).toBe(false);
  });

  it("别家的进门不算数：去重按房间隔离", () => {
    const clock = { now: t0 };
    const { db } = fakeDb(clock);
    logVisitorEvent(db, "guest-ccdd", "小李", "join", "role=user");
    expect(isNewJoin(db, "guest-aabb", Date.parse(t0))).toBe(true);
  });
});
