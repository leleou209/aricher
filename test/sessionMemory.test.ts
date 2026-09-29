/**
 * 会话记忆的读取测试。
 *
 * 这一层最容易碎的不是「能不能查出来」，而是**空条件有没有被当成过滤条件**：
 * 七个筛选项（场、语气、起、止、词、上限）里任何一个写成
 * `AND session_id = ''` 这种样子，面板就会永远空白 —— 而它不报错、不抛异常，
 * 看上去只像「她还没记过东西」。所以这一份测试盯的是「留空 = 不过滤」这条底线，
 * 以及落库那种原始列名能不能被正确翻成面板要的字段名。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import { listSessionMemories, sessionMemoryCounts } from "../src/agent/memory";
import {
  SENTIMENTS,
  normalizeSentiment,
  type SqlTag,
} from "../src/agent/state";

/** 一行"库里的"记忆，列名按库里的写法（下划线），不是面板字段 */
function row(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    date: "2026-09-24",
    type: "recap",
    tags: "recap,calm",
    weight: 0.5,
    shelf: "sessions",
    person: "",
    visibility: "private",
    content: "他今天在说那件事。",
    accessed: 0,
    learned: "2026-09-24T10:00:00.000Z",
    superseded_by: "",
    volatility: "stable",
    verified: "",
    valid_at: "2026-09-24T10:00:00.000Z",
    invalid_at: "",
    conflicts_with: "",
    title: "",
    file_key: "",
    session_id: "s1abc",
    sentiment: "calm",
    ...over,
  };
}

/**
 * 假库：不解释 SQL，只把发出去的语句和绑定值原样记下来，再照调用方摆好的行回话。
 * 这不是偷懒 —— 想验的正是「语句长什么样」，那就别让假引擎替我判一遍。
 */
function fakeDb(rows: Record<string, unknown>[] = []) {
  let last = { sql: "", values: [] as unknown[] };
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    last = { sql: strings.join("?").replace(/\s+/g, " ").trim(), values };
    if (last.sql.startsWith("SELECT session_id AS sessionId")) {
      const bySession = new Map<string, { n: number; last: string }>();
      for (const r of rows) {
        const id = String(r.session_id || "");
        if (!id) continue;
        const cur = bySession.get(id);
        const learned = String(r.learned || "");
        bySession.set(id, {
          n: (cur?.n ?? 0) + 1,
          last: !cur || learned > cur.last ? learned : cur.last,
        });
      }
      return [...bySession.entries()].map(([sessionId, v]) => ({
        sessionId,
        ...v,
      }));
    }
    return rows;
  };
  return {
    sql: tag as unknown as SqlTag,
    get last() {
      return last;
    },
  };
}

describe("listSessionMemories：留空 = 不过滤", () => {
  it("什么都不传时，每个筛选项都绑空串（不是写死等号），只钉 shelves 和未作废", () => {
    const db = fakeDb([row()]);
    listSessionMemories(db.sql);
    expect(db.last.sql).toContain("shelf = 'sessions'");
    expect(db.last.sql).toContain("superseded_by = ''");
    // 每个条件都要绑两次（`= ''` 那一半 + 真比一次），所以不能按位置数；
    // 反过来钉「除了 LIKE 的空样子和上限，其余全是空串」更贴题意。
    const filters = db.last.values.slice(0, -1) as string[];
    expect(filters.every((v) => v === "" || v === "%%")).toBe(true);
    // 正文和标签各一路 LIKE，所以空样子出现两次
    expect(filters.filter((v) => v === "%%")).toHaveLength(2);
    expect(db.last.values.at(-1)).toBe(200);
  });

  it("每一项都是「空串就放行」的形状 —— 不许写成 AND 字段 = 值", () => {
    const db = fakeDb();
    listSessionMemories(db.sql, { sessionId: "s1", sentiment: "warm" });
    // 每条过滤条件都得自带 `= ''` 那一半，否则留空时整句就是一句空查
    expect(db.last.sql).toContain("= '' OR session_id = ?");
    expect(db.last.sql).toContain("= '' OR sentiment = ?");
    expect(db.last.sql).toContain("= '' OR learned >= ?");
    expect(db.last.sql).toContain("= '' OR learned < ?");
  });

  it("关键词两边都套 %：正文和标签各匹配一路", () => {
    const db = fakeDb();
    listSessionMemories(db.sql, { q: "装修" });
    // 空串那一半绑的是原词，LIKE 那一半绑的是套了 % 的
    const vals = db.last.values as string[];
    expect(vals).toContain("装修");
    expect(vals.filter((v) => v === "%装修%")).toHaveLength(2);
    expect(db.last.sql).toContain("content LIKE ?");
    expect(db.last.sql).toContain("tags LIKE ?");
  });

  it("上限原样传进去，由调用方定（路由那一层才是夹到 1..500 的地方）", () => {
    const db = fakeDb();
    listSessionMemories(db.sql, { limit: 50 });
    expect(db.last.values.at(-1)).toBe(50);
  });
});

describe("listSessionMemories：原始列名翻成面板字段", () => {
  it("session_id / sentiment 读得回来", () => {
    const db = fakeDb([row()]);
    const [e] = listSessionMemories(db.sql);
    expect(e.sessionId).toBe("s1abc");
    expect(e.sentiment).toBe("calm");
  });

  it("老行没有这两列时落空串，不是 undefined —— 面板 everywhere 判空串", () => {
    const db = fakeDb([
      (() => {
        const r = row();
        delete (r as Record<string, unknown>).session_id;
        delete (r as Record<string, unknown>).sentiment;
        return r;
      })(),
    ]);
    const [e] = listSessionMemories(db.sql);
    expect(e.sessionId).toBe("");
    expect(e.sentiment).toBe("");
  });
});

describe("sessionMemoryCounts：左栏分组的账", () => {
  it("按场归拢，场为空的行不入账（那是没挂上会话的散条）", () => {
    const db = fakeDb([
      row({ session_id: "s1", learned: "2026-09-24T10:00:00.000Z" }),
      row({ session_id: "s1", learned: "2026-09-24T12:00:00.000Z" }),
      row({ session_id: "s2", learned: "2026-09-23T10:00:00.000Z" }),
      row({ session_id: "" }),
    ]);
    const groups = sessionMemoryCounts(db.sql);
    expect(groups).toHaveLength(2);
    const s1 = groups.find((g) => g.sessionId === "s1")!;
    expect(s1.n).toBe(2);
    // 最后一次是最近那条，不是第一条
    expect(s1.last).toBe("2026-09-24T12:00:00.000Z");
  });

  it("语句里就挡掉了没挂会话的行，不靠外面再筛一遍", () => {
    const db = fakeDb();
    sessionMemoryCounts(db.sql);
    expect(db.last.sql).toContain("session_id <> ''");
    expect(db.last.sql).toContain("shelf = 'sessions'");
  });
});

describe("normalizeSentiment：认不出就落空串", () => {
  it("六个词原样通过（大小写和空白先归一）", () => {
    for (const s of SENTIMENTS) {
      expect(normalizeSentiment(s)).toBe(s);
      expect(normalizeSentiment(`  ${s.toUpperCase()} `)).toBe(s);
    }
  });

  it("编出来的语气不收：宁可没有标签，也不写一个没人认得的词", () => {
    for (const bad of ["开心", "happy", "warmish", "有点低落", "CALMING"]) {
      expect(normalizeSentiment(bad)).toBe("");
    }
  });

  it("返回值只可能是那六个词之一或者空串 —— 面板的颜色表按这个假设写", () => {
    for (const input of ["warm", "WARM", "tired", "说不上来", "  ", ""]) {
      const got = normalizeSentiment(input);
      expect(
        got === "" || (SENTIMENTS as readonly string[]).includes(got),
      ).toBe(true);
    }
  });
});
