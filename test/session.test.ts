/**
 * 会话正文保存测试。
 *
 * 这里只测一件要紧的事：saveSessionMessages 是不是真的「只写变了的那些」。
 * 原来它每轮先清空再全量写回，一轮光存快照就写掉四百来行 ——
 * 免费层一天只有十万行，这一个人的账就吃掉一大块。
 *
 * 用一个最小的假 SQL 引擎（认得 saveSessionMessages / loadSessionMessages
 * 会发的那几条语句），既数得出写了几行，又能验内容对不对。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  loadSessionMessages,
  saveSessionMessages,
} from "../src/agent/sessionStore";
import type { SqlTag } from "../src/agent/state";

/** 只认这几条语句的假库。不追求通用，够验这一件事就行。 */
function fakeDb() {
  const rows = new Map<string, Map<number, string>>(); // session_id -> seq -> message
  const writes: string[] = [];

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();
    const [id, seq, message] = values as [string, number, string];

    if (sql.startsWith("select seq, message from session_messages")) {
      const bucket = rows.get(id);
      if (!bucket) return [] as T[];
      return [...bucket.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([s, m]) => ({ seq: s, message: m })) as T[];
    }

    if (sql.startsWith("select message from session_messages")) {
      const bucket = rows.get(id);
      if (!bucket) return [] as T[];
      return [...bucket.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, m]) => ({ message: m })) as T[];
    }

    if (sql.startsWith("insert into session_messages")) {
      writes.push("insert");
      if (!rows.has(id)) rows.set(id, new Map());
      rows.get(id)!.set(seq, message);
      return [] as T[];
    }

    if (
      sql.startsWith(
        "delete from session_messages where session_id = ? and seq >=",
      )
    ) {
      writes.push("delete");
      const bucket = rows.get(id);
      if (bucket)
        for (const k of [...bucket.keys()]) if (k >= seq) bucket.delete(k);
      return [] as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return {
    db,
    writes,
    count: (id: string) => rows.get(id)?.size ?? 0,
    get: (id: string, seq: number) => rows.get(id)?.get(seq),
  };
}

const msg = (id: string, text: string): UIMessage =>
  ({
    id,
    role: "user",
    parts: [{ type: "text", text }],
  }) as unknown as UIMessage;

describe("saveSessionMessages", () => {
  it("第一遍全写，第二遍一模一样的就一个字都不写", () => {
    const store = fakeDb();
    const first = [msg("a", "你好"), msg("b", "在吗")];
    saveSessionMessages(store.db, "s1", first);
    expect(store.writes.length).toBe(2);

    saveSessionMessages(store.db, "s1", first);
    expect(store.writes.length).toBe(2); // 没多一条
  });

  it("追加一轮：只写新来的那两条，旧的原样躺着", () => {
    const store = fakeDb();
    const base = [msg("a", "你好"), msg("b", "在吗")];
    saveSessionMessages(store.db, "s1", base);
    store.writes.length = 0;

    saveSessionMessages(store.db, "s1", [
      ...base,
      msg("c", "帮我看看"),
      msg("d", "好"),
    ]);
    expect(store.writes).toEqual(["insert", "insert"]);
    expect(store.count("s1")).toBe(4);
  });

  it("最后一条被改过（流式回答在长），只重写那一条", () => {
    const store = fakeDb();
    saveSessionMessages(store.db, "s1", [msg("a", "你好"), msg("b", "半句话")]);
    store.writes.length = 0;

    saveSessionMessages(store.db, "s1", [
      msg("a", "你好"),
      msg("b", "半句话，说完了"),
    ]);
    expect(store.writes).toEqual(["insert"]);
    expect(JSON.parse(store.get("s1", 1)!)).toMatchObject({ id: "b" });
  });

  it("会话被清短了才删尾巴；没多出来的不发删除语句", () => {
    const store = fakeDb();
    saveSessionMessages(store.db, "s1", [
      msg("a", "1"),
      msg("b", "2"),
      msg("c", "3"),
    ]);
    store.writes.length = 0;

    saveSessionMessages(store.db, "s1", [msg("a", "1")]);
    expect(store.writes).toEqual(["delete"]);
    expect(store.count("s1")).toBe(1);

    store.writes.length = 0;
    saveSessionMessages(store.db, "s1", [msg("a", "1")]);
    expect(store.writes).toEqual([]); // 不多发那条删零行的
  });

  it("存进去再读回来，内容一条不差、顺序也对", () => {
    const store = fakeDb();
    const list = [msg("a", "第一句"), msg("b", "第二句"), msg("c", "第三句")];
    saveSessionMessages(store.db, "s1", list);
    const back = loadSessionMessages(store.db, "s1");
    expect(back.map((m) => m.id)).toEqual(["a", "b", "c"]);
    // 库里存的是键名排过序的 JSON，所以只比内容，不比字符串长相
    expect(back.map((m) => (m.parts[0] as { text: string }).text)).toEqual([
      "第一句",
      "第二句",
      "第三句",
    ]);
  });

  it("键序变了不算「变了」—— 不然每轮都会把两百条全部重写", () => {
    const store = fakeDb();
    saveSessionMessages(store.db, "s1", [
      {
        id: "a",
        role: "user",
        parts: [{ type: "text", text: "你好" }],
      } as unknown as UIMessage,
    ]);
    store.writes.length = 0;
    // 同一份内容，键序换了一下
    saveSessionMessages(store.db, "s1", [
      {
        parts: [{ text: "你好", type: "text" }],
        role: "user",
        id: "a",
      } as unknown as UIMessage,
    ]);
    expect(store.writes).toEqual([]);
  });

  it("两场会话互不干扰", () => {
    const store = fakeDb();
    saveSessionMessages(store.db, "s1", [msg("a", "甲")]);
    saveSessionMessages(store.db, "s2", [msg("b", "乙")]);
    saveSessionMessages(store.db, "s1", [msg("a", "甲"), msg("c", "丙")]);
    expect(store.count("s1")).toBe(2);
    expect(store.count("s2")).toBe(1);
  });
});

/**
 * 返回值就是「有没有新内容」——外面拿它决定要不要动 last_active。
 * 会话列表按 last_active 排，所以这个 bool 一旦报错，表现就是
 * 「点哪一场哪一场跳到最前面」，或者反过来「新消息来了那一场却不上浮」。
 */
describe("saveSessionMessages 的返回值", () => {
  it("一个字没变时报 false —— 光翻列表、点开旧的一场都不算新内容", () => {
    const store = fakeDb();
    const list = [msg("a", "你好")];
    expect(saveSessionMessages(store.db, "s1", list)).toBe(true);
    expect(saveSessionMessages(store.db, "s1", list)).toBe(false);
    expect(saveSessionMessages(store.db, "s1", list)).toBe(false);
  });

  it("来了新消息、或者某一条被改写时报 true", () => {
    const store = fakeDb();
    saveSessionMessages(store.db, "s1", [msg("a", "你好")]);
    expect(
      saveSessionMessages(store.db, "s1", [msg("a", "你好"), msg("b", "在吗")]),
    ).toBe(true);
    expect(
      saveSessionMessages(store.db, "s1", [
        msg("a", "你好"),
        msg("b", "在吗，问件事"),
      ]),
    ).toBe(true);
  });

  it("只删掉尾巴也算变了（少说了一句，那也是变了）", () => {
    const store = fakeDb();
    saveSessionMessages(store.db, "s1", [msg("a", "1"), msg("b", "2")]);
    expect(saveSessionMessages(store.db, "s1", [msg("a", "1")])).toBe(true);
    expect(saveSessionMessages(store.db, "s1", [msg("a", "1")])).toBe(false);
  });
});
