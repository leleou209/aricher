/**
 * 读音配置目录（tts_configs）测试。
 *
 * 这张表比 model_configs 简单：没有「生效中」的概念 —— 顺序即优先级，
 * 念的时候从头找第一条 key 可用的。所以这里只验：
 * - 增删改查，字段缺省不动；
 * - protocol 三值校验与必填校验，拒的时候要听得懂；
 * - created 序稳定（那是优先级的全部依据）。
 *
 * 表用最小假 SQL 引擎，只认得 ttsConfigs.ts 会发的那几条语句。
 *
 * 运行: npx vitest run test/ttsConfigs.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  createTtsConfig,
  listTtsConfigs,
  removeTtsConfig,
  updateTtsConfig,
} from "../src/agent/ttsConfigs";
import type { SqlTag } from "../src/agent/state";

interface Row {
  id: string;
  name: string;
  protocol: string;
  base_url: string;
  key_secret: string;
  model: string;
  voice: string;
  style: string;
  active: number;
  created: string;
}

/** 最小假 SQL 引擎：行存成 snake_case，语句按前缀认 */
function fakeDb() {
  const rows: Row[] = [];

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table")) return [] as T[];

    if (sql.startsWith("insert into tts_configs")) {
      const [
        id,
        name,
        protocol,
        base_url,
        key_secret,
        model,
        voice,
        style,
        active,
        created,
      ] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        string,
      ];
      rows.push({
        id,
        name,
        protocol,
        base_url,
        key_secret,
        model,
        voice,
        style,
        active: Number(active),
        created,
      });
      return [] as T[];
    }

    if (sql.startsWith("update tts_configs set")) {
      const [name, protocol, base_url, key_secret, model, voice, style, id] =
        values as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("假库：update 没找到行");
      Object.assign(row, {
        name,
        protocol,
        base_url,
        key_secret,
        model,
        voice,
        style,
      });
      return [] as T[];
    }

    if (sql.startsWith("delete from tts_configs")) {
      const [id] = values as [string];
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return [] as T[];
    }

    if (sql.startsWith("select id from tts_configs")) {
      const [id] = values as [string];
      return rows.filter((r) => r.id === id).map((r) => ({ id: r.id })) as T[];
    }

    if (sql.startsWith("select id, name, protocol")) {
      if (sql.includes("where id =")) {
        const [id] = values as [string];
        return rows.filter((r) => r.id === id) as T[];
      }
      return [...rows] as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return { db, rows };
}

const ok = {
  name: "小米朗读",
  protocol: "mimo-chat",
  keySecret: "MIMO_API_KEY",
};

describe("tts_configs 增删改查", () => {
  it("建一条读得回来：id 是 8 位 hex，可选字段缺省为空", () => {
    const { db } = fakeDb();
    const c = createTtsConfig(db, ok);
    expect(c.id).toMatch(/^[0-9a-f]{8}$/);
    expect(c.name).toBe("小米朗读");
    expect(c.protocol).toBe("mimo-chat");
    expect(c.keySecret).toBe("MIMO_API_KEY");
    expect(c.baseUrl).toBe("");
    expect(c.model).toBe("");
    expect(c.voice).toBe("");
    expect(c.style).toBe("");
    expect(listTtsConfigs(db).map((x) => x.name)).toEqual(["小米朗读"]);
  });

  it("created 序就是优先级：先来的排前面", () => {
    const { db } = fakeDb();
    createTtsConfig(db, ok);
    createTtsConfig(db, {
      ...ok,
      name: "智谱",
      protocol: "glm-speech",
      keySecret: "ZHIPU_KEY",
    });
    expect(listTtsConfigs(db).map((x) => x.name)).toEqual(["小米朗读", "智谱"]);
  });

  it("改一条：字段缺省不动，可选字段能改", () => {
    const { db } = fakeDb();
    const c = createTtsConfig(db, ok);
    const up = updateTtsConfig(db, c.id, { voice: "茉莉", style: "轻快点念" });
    expect(up?.voice).toBe("茉莉");
    expect(up?.style).toBe("轻快点念");
    expect(up?.keySecret).toBe("MIMO_API_KEY");
    expect(up?.baseUrl).toBe("");
  });

  it("删一条；没这条返回 false", () => {
    const { db } = fakeDb();
    const c = createTtsConfig(db, ok);
    expect(removeTtsConfig(db, c.id)).toBe(true);
    expect(listTtsConfigs(db)).toHaveLength(0);
    expect(removeTtsConfig(db, c.id)).toBe(false);
  });

  it("没这一条：改返回 null", () => {
    const { db } = fakeDb();
    expect(updateTtsConfig(db, "nope", { name: "x" })).toBeNull();
  });
});

describe("tts_configs 校验", () => {
  it("protocol 必须是三值之一", () => {
    const { db } = fakeDb();
    expect(() => createTtsConfig(db, { ...ok, protocol: "azure" })).toThrow(
      /读音协议/,
    );
    expect(() => createTtsConfig(db, { ...ok, protocol: "" })).toThrow(
      /protocol/,
    );
    const c = createTtsConfig(db, ok);
    expect(() => updateTtsConfig(db, c.id, { protocol: "polly" })).toThrow(
      /读音协议/,
    );
    expect(updateTtsConfig(db, c.id, { protocol: "doubao" })?.protocol).toBe(
      "doubao",
    );
  });

  it("缺必填：逐项拒", () => {
    const { db } = fakeDb();
    expect(() => createTtsConfig(db, { ...ok, name: "" })).toThrow(/名称/);
    expect(() => createTtsConfig(db, { ...ok, keySecret: " " })).toThrow(
      /keySecret/,
    );
  });

  it("改成空值同样拒", () => {
    const { db } = fakeDb();
    const c = createTtsConfig(db, ok);
    expect(() => updateTtsConfig(db, c.id, { name: "  " })).toThrow(/名称/);
    expect(() => updateTtsConfig(db, c.id, { keySecret: "" })).toThrow(
      /keySecret/,
    );
  });
});
