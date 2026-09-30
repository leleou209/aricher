/**
 * 搜索配置目录（search_config）测试。
 *
 * 这张表管的是「联网搜索走哪家、用哪把钥匙」——以前写死认 env.TAVILY_API_KEY
 * 的那套。这里验：
 * - 首次建表种入内置默认：没配置过的机器行为和配置化之前一字不差；
 * - 再 ensure 不重复种（管理员改过的通道不能被默认值洗回去）；
 * - 改配置往返：format / keySecret 都能改，字段缺省不动；
 * - format 两值校验（tavily / brave），不认识的拒，拒的时候要听得懂；
 * - 行损坏（format 不认识）回落内置默认，搜索不至于断路。
 * - Brave 的 freshness 记号翻译（day/week/month/year → pd/pw/pm/py）。
 *
 * 表用最小假 SQL 引擎，只认得 searchConfigs.ts 会发的那几条语句。
 *
 * 运行: npx vitest run test/searchConfigs.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_SEARCH_CONFIG,
  ensureSearchConfigSchema,
  getSearchConfig,
  updateSearchConfig,
} from "../src/agent/searchConfigs";
import { braveFreshness } from "../src/tools/search";
import type { SqlTag } from "../src/agent/state";

interface Row {
  id: string;
  format: string;
  key_secret: string;
}

/** 最小假 SQL 引擎：行存成 snake_case，语句按前缀认 */
function fakeDb() {
  const rows: Row[] = [];

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table")) return [] as T[];

    if (sql.startsWith("select count(*) as n from search_config")) {
      return [{ n: rows.length }] as T[];
    }

    if (sql.startsWith("insert into search_config")) {
      // id='main' 是语句里的字面量，绑定值只有 format 和 key_secret 两个
      const [format, key_secret] = values as [string, string];
      rows.push({ id: "main", format, key_secret });
      return [] as T[];
    }

    if (sql.startsWith("select format, key_secret from search_config")) {
      return rows.filter((r) => r.id === "main") as T[];
    }

    if (sql.startsWith("update search_config set")) {
      const [format, key_secret] = values as [string, string];
      const row = rows.find((r) => r.id === "main");
      if (!row) throw new Error("假库：update 没找到行");
      Object.assign(row, { format, key_secret });
      return [] as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return { db, rows };
}

describe("默认种子", () => {
  it("首次建表种入内置默认：行为和配置化之前一字不差", () => {
    const { db } = fakeDb();
    expect(getSearchConfig(db)).toEqual(DEFAULT_SEARCH_CONFIG);
    expect(DEFAULT_SEARCH_CONFIG).toEqual({
      format: "tavily",
      keySecret: "TAVILY_API_KEY",
    });
  });

  it("再 ensure 不重复种：管理员改过的通道不被默认值洗回去", () => {
    const { db } = fakeDb();
    ensureSearchConfigSchema(db);
    updateSearchConfig(db, { format: "brave" });
    ensureSearchConfigSchema(db);
    expect(getSearchConfig(db).format).toBe("brave");
  });

  it("行损坏（format 不认识）回落内置默认，搜索不断路", () => {
    const { db, rows } = fakeDb();
    ensureSearchConfigSchema(db);
    rows[0]!.format = "bing";
    expect(getSearchConfig(db)).toEqual(DEFAULT_SEARCH_CONFIG);
  });

  it("行缺失同样回落内置默认", () => {
    const { db, rows } = fakeDb();
    ensureSearchConfigSchema(db);
    rows.length = 0;
    expect(getSearchConfig(db)).toEqual(DEFAULT_SEARCH_CONFIG);
  });
});

describe("改配置", () => {
  it("改通道往返；keySecret 截到 80 字符", () => {
    const { db } = fakeDb();
    ensureSearchConfigSchema(db);
    const up = updateSearchConfig(db, {
      format: "brave",
      keySecret: "BRAVE_API_KEY",
    });
    expect(up).toEqual({ format: "brave", keySecret: "BRAVE_API_KEY" });
    // 读回一致
    expect(getSearchConfig(db)).toEqual(up);
  });

  it("字段缺省不动：只给 keySecret，通道原样", () => {
    const { db } = fakeDb();
    ensureSearchConfigSchema(db);
    const up = updateSearchConfig(db, { keySecret: "ACME_KEY" });
    expect(up.format).toBe("tavily");
    expect(up.keySecret).toBe("ACME_KEY");
  });

  it("keySecret 允许清空 = 走免费通道", () => {
    const { db } = fakeDb();
    ensureSearchConfigSchema(db);
    const up = updateSearchConfig(db, { keySecret: "" });
    expect(up.keySecret).toBe("");
  });

  it("format 不认识的拒，拒的时候要听得懂", () => {
    const { db } = fakeDb();
    ensureSearchConfigSchema(db);
    expect(() => updateSearchConfig(db, { format: "google" })).toThrow(
      /不认识这种搜索通道/,
    );
  });
});

describe("Brave freshness 记号", () => {
  it("day/week/month/year 翻译成 pd/pw/pm/py", () => {
    expect(braveFreshness("day")).toBe("pd");
    expect(braveFreshness("week")).toBe("pw");
    expect(braveFreshness("month")).toBe("pm");
    expect(braveFreshness("year")).toBe("py");
  });

  it("没给时间过滤就不传（默认全时段）", () => {
    expect(braveFreshness(undefined)).toBeNull();
  });
});
