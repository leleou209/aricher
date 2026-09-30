/**
 * 跨场并账的存储层测试：场屋寄回主屋的两本账。
 *
 * - 记忆快照（upsertMemorySnapshot）：整行照抄、按 id 幂等，读回来字段对得上
 * - 原话索引（recall_index）：按消息 id 幂等，join 目录行搜得回「谁在哪场说了什么」
 *
 * 用最小假 SQL 引擎，只认得这两条路会发的语句（风格同 visitor.test.ts）。
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import { upsertMemorySnapshot, getMemory } from "../src/agent/memory";
import {
  insertRecallIndexRows,
  searchRecallIndex,
  type RecallIndexRow,
} from "../src/agent/sessionStore";
import type { MemEntry, SqlTag } from "../src/agent/state";

/** 一条形状完整的记忆（快照收账要求至少有 id 和 content） */
function mem(id: string, content: string): MemEntry {
  return {
    id,
    date: "2026-10-01",
    type: "insight",
    tags: ["测试"],
    weight: 0.5,
    shelf: "knowledge",
    person: "",
    visibility: "private",
    hold: false,
    content,
    accessed: 0,
    learned: "2026-10-01T00:00:00.000Z",
    supersededBy: "",
    volatility: "stable",
    verified: "",
    validAt: "2026-10-01T00:00:00.000Z",
    invalidAt: "",
    conflictsWith: [],
    title: "",
    fileKey: "",
    sessionId: "",
    sentiment: "",
    sensitivity: "normal",
    score: 3,
  };
}

/** memories 表的 27 列，顺序与 upsertMemorySnapshot 的 INSERT 严格一致 */
const MEM_COLS = [
  "id",
  "date",
  "type",
  "tags",
  "weight",
  "shelf",
  "person",
  "visibility",
  "content",
  "accessed",
  "learned",
  "superseded_by",
  "volatility",
  "verified",
  "valid_at",
  "invalid_at",
  "conflicts_with",
  "title",
  "file_key",
  "session_id",
  "sentiment",
  "sensitivity",
  "score",
  "owner_key",
  "visibility_hold",
  "dedupe_key",
  "last_accessed_at",
] as const;

function fakeDb() {
  const memories = new Map<string, Record<string, unknown>>();
  const recallIndex = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, { title: string; last_active: string }>();

  const db = (<T>(strings: TemplateStringsArray, ...v: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table") || sql.startsWith("create index"))
      return [] as T[];

    if (sql.startsWith("insert or replace into memories")) {
      const row: Record<string, unknown> = {};
      MEM_COLS.forEach((c, i) => (row[c] = v[i]));
      memories.set(row.id as string, row);
      return [] as T[];
    }

    if (sql.startsWith("select * from memories where id")) {
      const row = memories.get(v[0] as string);
      return (row ? [row] : []) as T[];
    }

    if (sql.startsWith("insert or ignore into recall_index")) {
      const [id, sessionId, role, text, ts] = v as [
        string,
        string,
        string,
        string,
        string,
      ];
      if (!recallIndex.has(id))
        recallIndex.set(id, { id, session_id: sessionId, role, text, ts });
      return [] as T[];
    }

    // searchRecallIndex 的 join 查询：LIKE 命中后 join sessions，目录行不在就掉行。
    // 两个 LIKE 参数（text、title）+ limit，共三个
    if (
      sql.startsWith(
        "select i.session_id, i.text, i.role, s.title, s.last_active",
      )
    ) {
      const needle = (v[0] as string).replace(/%/g, "").toLowerCase();
      const limit = v[2] as number;
      return [...recallIndex.values()]
        .filter((r) => (r.text as string).toLowerCase().includes(needle))
        .map((r) => {
          const s = sessions.get(r.session_id as string);
          return {
            session_id: r.session_id,
            text: r.text,
            role: r.role,
            title: s?.title ?? "",
            last_active: s?.last_active ?? "",
          };
        })
        .filter((r) => r.title !== "")
        .slice(0, limit) as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return { db, memories, recallIndex, sessions };
}

describe("记忆快照并账（upsertMemorySnapshot）", () => {
  it("整行照抄：读回来的字段和寄来的快照对得上", () => {
    const { db } = fakeDb();
    const source = mem("m-abc", "他负责哪个项目就记哪个");
    upsertMemorySnapshot(db, source);
    const got = getMemory(db, "m-abc");
    expect(got).not.toBeNull();
    expect(got!.content).toBe(source.content);
    expect(got!.shelf).toBe(source.shelf);
    expect(got!.tags).toEqual(source.tags);
    expect(got!.volatility).toBe(source.volatility);
    expect(got!.sensitivity).toBe(source.sensitivity);
    expect(got!.score).toBe(source.score);
    expect(got!.supersededBy).toBe("");
    expect(got!.hold).toBe(false);
  });

  it("同 id 反复寄，最后一次为准（durable queue 重试安全）", () => {
    const { db } = fakeDb();
    upsertMemorySnapshot(db, mem("m-abc", "第一版"));
    upsertMemorySnapshot(db, { ...mem("m-abc", "第二版") });
    expect(getMemory(db, "m-abc")!.content).toBe("第二版");
  });

  it("作废与疑问的状态跟着快照走：变更并账靠它", () => {
    const { db } = fakeDb();
    upsertMemorySnapshot(db, {
      ...mem("m-old", "旧说法"),
      supersededBy: "m-new",
      invalidAt: "2026-10-02T00:00:00.000Z",
    });
    const got = getMemory(db, "m-old");
    expect(got!.supersededBy).toBe("m-new");
    expect(got!.invalidAt).toBe("2026-10-02T00:00:00.000Z");
  });
});

describe("原话索引并账（recall_index）", () => {
  const row = (
    id: string,
    sessionId: string,
    text: string,
  ): RecallIndexRow => ({
    id,
    sessionId,
    role: "user",
    text,
    ts: "2026-10-01T00:00:00.000Z",
  });

  it("寄回的行 join 目录行搜得回来：谁在哪场说了什么", () => {
    const { db, sessions } = fakeDb();
    sessions.set("s-1", { title: "项目排期", last_active: "2026-10-01" });
    insertRecallIndexRows(db, [row("msg-1", "s-1", "把部署窗口定在周四")]);
    const hits = searchRecallIndex(db, "部署窗口", 8);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      sessionId: "s-1",
      sessionTitle: "项目排期",
      role: "user",
      message: "把部署窗口定在周四",
    });
  });

  it("按消息 id 幂等：场屋重启后全量重寄也不会写重", () => {
    const { db, recallIndex, sessions } = fakeDb();
    sessions.set("s-1", { title: "项目排期", last_active: "2026-10-01" });
    const rows = [row("msg-1", "s-1", "同一句话")];
    insertRecallIndexRows(db, rows);
    insertRecallIndexRows(db, rows);
    insertRecallIndexRows(db, rows);
    expect(recallIndex.size).toBe(1);
  });

  it("没登记目录行的场搜不到（join 掉行，与真库语义一致）", () => {
    const { db } = fakeDb();
    insertRecallIndexRows(db, [row("msg-1", "s-404", "孤儿索引行")]);
    expect(searchRecallIndex(db, "孤儿", 8)).toHaveLength(0);
  });

  it("形状不完整的行不收：宁缺毋滥", () => {
    const { db, recallIndex } = fakeDb();
    insertRecallIndexRows(db, [
      { id: "", sessionId: "s-1", role: "user", text: "没有 id 的行", ts: "" },
      { id: "msg-2", sessionId: "s-1", role: "user", text: "   ", ts: "" },
      row("msg-3", "s-1", "正常的一行"),
    ]);
    expect(recallIndex.size).toBe(1);
  });
});
