/**
 * 公开墙（public_posts）测试。
 *
 * 墙是这个家的公告板：permPublic 档位的持卡者贴纸条，进门的人谁都看得到。
 * 验的是三件事：
 * - 贴：内容必填、500 字封顶、署名快照（没名给「无名氏」）；
 * - 看：新的在前，读墙不改墙；
 * - 摘：管理员摘任意一条；持卡者只摘得动自己那张卡贴的 ——
 *   「这条不在墙上」和「不是你贴的」外面看起来一个样（都摘不掉）。
 *
 * 名册用最小假 SQL 引擎，只认得 publicPosts.ts 会发的那几条语句。
 *
 * 运行: npx vitest run test/publicPosts.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  createPublicPost,
  listPublicPosts,
  removePublicPost,
} from "../src/agent/publicPosts";
import type { SqlTag } from "../src/agent/state";

/** 最小假 SQL 引擎：行存成 snake_case，语句按前缀认 */
function fakeDb() {
  const rows: Array<{
    id: string;
    card_id: string;
    author: string;
    content: string;
    created: string;
  }> = [];

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table")) return [] as T[];

    if (sql.startsWith("insert into public_posts")) {
      const [id, card_id, author, content, created] = values as [
        string,
        string,
        string,
        string,
        string,
      ];
      rows.push({ id, card_id, author, content, created });
      return [] as T[];
    }

    if (sql.startsWith("select id, card_id, author")) {
      return [...rows].sort((a, b) => (a.created < b.created ? 1 : -1)) as T[];
    }

    if (sql.startsWith("select id from public_posts")) {
      const [id, cardId] = values as [string, string?];
      // 带 card_id 的查法是「这条在不在墙上，且是不是这张卡贴的」
      const hit = rows.find(
        (r) => r.id === id && (cardId === undefined || r.card_id === cardId),
      );
      return hit ? ([{ id: hit.id }] as T[]) : ([] as T[]);
    }

    if (sql.startsWith("delete from public_posts where id")) {
      const [id] = values as [string];
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return [] as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return { db, rows };
}

describe("贴墙", () => {
  it("贴一条读得回来：id 8 位 hex、署名和内容都记着", () => {
    const { db } = fakeDb();
    const post = createPublicPost(db, {
      cardId: "card-ab12",
      author: "陈客",
      content: "周六下午我过来一趟",
    });
    expect(post.id).toMatch(/^[0-9a-f]{8}$/);
    expect(post.author).toBe("陈客");
    expect(post.content).toBe("周六下午我过来一趟");
    expect(post.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(listPublicPosts(db)).toHaveLength(1);
  });

  it("内容必填：白纸不贴；空格 trim 之后还是空也不贴", () => {
    const { db } = fakeDb();
    expect(() =>
      createPublicPost(db, { cardId: "c", author: "a", content: "" }),
    ).toThrow(/不能空/);
    expect(() =>
      createPublicPost(db, { cardId: "c", author: "a", content: "   " }),
    ).toThrow(/不能空/);
  });

  it("500 字封顶：长了截掉，别把墙撑破", () => {
    const { db } = fakeDb();
    const post = createPublicPost(db, {
      cardId: "c",
      author: "a",
      content: "长".repeat(600),
    });
    expect(post.content).toHaveLength(500);
  });

  it("署名是快照：空名落成「无名氏」；40 字封顶", () => {
    const { db } = fakeDb();
    const anon = createPublicPost(db, {
      cardId: "c",
      author: "  ",
      content: "路过来打个招呼",
    });
    expect(anon.author).toBe("无名氏");
    const long = createPublicPost(db, {
      cardId: "c",
      author: "名".repeat(50),
      content: "名字太长也收得下",
    });
    expect(long.author).toHaveLength(40);
  });
});

describe("看墙与摘墙", () => {
  it("新的在前：晚贴的排上面", () => {
    const { db, rows } = fakeDb();
    createPublicPost(db, { cardId: "c1", author: "早", content: "第一条" });
    const second = createPublicPost(db, {
      cardId: "c2",
      author: "晚",
      content: "第二条",
    });
    // 同一毫秒内贴的两条时间戳可能相同：手动把第二条拨后，排序才有定论
    rows[1].created = new Date(Date.now() + 10_000).toISOString();
    const wall = listPublicPosts(db);
    expect(wall[0].id).toBe(second.id);
  });

  it("管理员摘任意一条：在墙上返回 true，摘完墙上看不见", () => {
    const { db } = fakeDb();
    const post = createPublicPost(db, {
      cardId: "card-ab12",
      author: "陈客",
      content: "贴错了，摘了吧",
    });
    expect(removePublicPost(db, post.id)).toBe(true);
    expect(listPublicPosts(db)).toHaveLength(0);
  });

  it("持卡者只摘得动自己贴的：别人的贴子摘不掉，返回 false", () => {
    const { db } = fakeDb();
    const mine = createPublicPost(db, {
      cardId: "card-ab12",
      author: "陈客",
      content: "我贴的",
    });
    const others = createPublicPost(db, {
      cardId: "card-ffff",
      author: "李客",
      content: "别人贴的",
    });
    // 摘自己的行；摘别人的不行
    expect(removePublicPost(db, mine.id, "card-ab12")).toBe(true);
    expect(removePublicPost(db, others.id, "card-ab12")).toBe(false);
    // id 都不存在也一样：不给试探者区分「没这条」和「不是你的」
    expect(removePublicPost(db, "no-such", "card-ab12")).toBe(false);
    expect(listPublicPosts(db)).toHaveLength(1);
  });
});
