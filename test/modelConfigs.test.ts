/**
 * 模型厂商配置目录（model_configs）测试。
 *
 * 验的是这张目录靠不靠得住：
 * - 增删改查全路径，字段缺省不动；
 * - 必填与 format 三值校验：不对就拒，拒的话要听得懂；
 * - 生效唯一性：activate 先全清再置一，目录里永远最多一条生效；
 * - 删掉生效条目时，最新的另一条自动顶上 —— 目录不能出现「空转」状态；
 * - 首个条目自动生效（不然建完还得手动点一下，是段没人需要的死循环）。
 *
 * 表用最小假 SQL 引擎，只认得 modelConfigs.ts 会发的那几条语句。
 *
 * 运行: npx vitest run test/modelConfigs.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  activateModelConfig,
  createModelConfig,
  getActiveModelConfig,
  getConfigById,
  listModelConfigs,
  removeModelConfig,
  toMaxOutput,
  updateModelConfig,
} from "../src/agent/modelConfigs";
import type { SqlTag } from "../src/agent/state";

interface Row {
  id: string;
  name: string;
  format: string;
  base_url: string;
  key_secret: string;
  model: string;
  max_output: number;
  maint_key_secret: string;
  maint_model: string;
  active: number;
  created: string;
}

/** 最小假 SQL 引擎：行存成 snake_case，语句按前缀认 */
function fakeDb() {
  const rows: Row[] = [];

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table")) return [] as T[];

    if (sql.startsWith("insert into model_configs")) {
      const [
        id,
        name,
        format,
        base_url,
        key_secret,
        model,
        max_output,
        maint_key_secret,
        maint_model,
        active,
        created,
      ] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        string,
        string,
        number,
        string,
      ];
      rows.push({
        id,
        name,
        format,
        base_url,
        key_secret,
        model,
        max_output: Number(max_output),
        maint_key_secret,
        maint_model,
        active: Number(active),
        created,
      });
      return [] as T[];
    }

    if (sql.startsWith("update model_configs set active = 0")) {
      for (const r of rows) r.active = 0;
      return [] as T[];
    }

    if (sql.startsWith("update model_configs set active = 1")) {
      const [id] = values as [string];
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("假库：activate 没找到行");
      row.active = 1;
      return [] as T[];
    }

    if (sql.startsWith("update model_configs set")) {
      const [
        name,
        format,
        base_url,
        key_secret,
        model,
        max_output,
        maint_key_secret,
        maint_model,
        active,
        id,
      ] = values as [
        string,
        string,
        string,
        string,
        string,
        number,
        string,
        string,
        number,
        string,
      ];
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("假库：update 没找到行");
      Object.assign(row, {
        name,
        format,
        base_url,
        key_secret,
        model,
        max_output: Number(max_output),
        maint_key_secret,
        maint_model,
        active: Number(active),
      });
      return [] as T[];
    }

    if (sql.startsWith("delete from model_configs")) {
      const [id] = values as [string];
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return [] as T[];
    }

    if (sql.startsWith("select id, active from model_configs")) {
      const [id] = values as [string];
      return rows
        .filter((r) => r.id === id)
        .map((r) => ({ id: r.id, active: r.active })) as T[];
    }

    if (sql.startsWith("select id, name, format")) {
      if (sql.includes("where active = 1"))
        return rows.filter((r) => r.active === 1) as T[];
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
  name: "DeepSeek 主线",
  format: "anthropic",
  baseUrl: "https://api.deepseek.com/anthropic",
  keySecret: "DEEPSEEK_KEY",
  model: "deepseek-v4-pro",
};

describe("model_configs 增删改查", () => {
  it("建一条读得回来：id 是 8 位 hex，缺省 maxOutput 32768、维护字段空", () => {
    const { db } = fakeDb();
    const c = createModelConfig(db, ok);
    expect(c.id).toMatch(/^[0-9a-f]{8}$/);
    expect(c.name).toBe("DeepSeek 主线");
    expect(c.format).toBe("anthropic");
    expect(c.maxOutput).toBe(32768);
    expect(c.maintKeySecret).toBe("");
    expect(c.maintModel).toBe("");
    expect(c.active).toBe(true);
    expect(listModelConfigs(db).map((x) => x.name)).toEqual(["DeepSeek 主线"]);
  });

  it("第一个条目自动生效，后面的默认不生效", () => {
    const { db } = fakeDb();
    const a = createModelConfig(db, ok);
    const b = createModelConfig(db, { ...ok, name: "GLM", model: "glm-5.3" });
    expect(a.active).toBe(true);
    expect(b.active).toBe(false);
    expect(getActiveModelConfig(db)?.id).toBe(a.id);
  });

  it("activate 点名生效且全目录唯一", () => {
    const { db } = fakeDb();
    const a = createModelConfig(db, ok);
    const b = createModelConfig(db, { ...ok, name: "GLM" });
    const hit = activateModelConfig(db, b.id);
    expect(hit?.active).toBe(true);
    expect(getActiveModelConfig(db)?.id).toBe(b.id);
    expect(listModelConfigs(db).filter((x) => x.active)).toHaveLength(1);
    expect(listModelConfigs(db).find((x) => x.id === a.id)?.active).toBe(false);
  });

  it("改一条：字段缺省不动，active 能直接改", () => {
    const { db } = fakeDb();
    const a = createModelConfig(db, ok);
    const up = updateModelConfig(db, a.id, { name: "改名", maxOutput: 16384 });
    expect(up?.name).toBe("改名");
    expect(up?.maxOutput).toBe(16384);
    expect(up?.format).toBe("anthropic");
    expect(up?.keySecret).toBe("DEEPSEEK_KEY");
    expect(updateModelConfig(db, a.id, { active: false })?.active).toBe(false);
  });

  it("max_output 只认正整数，其余一律回 32768", () => {
    expect(toMaxOutput(8192)).toBe(8192);
    expect(toMaxOutput(0)).toBe(32768);
    expect(toMaxOutput(-1)).toBe(32768);
    expect(toMaxOutput(1.5)).toBe(32768);
    expect(toMaxOutput(undefined)).toBe(32768);
  });

  it("删一条普通条目：生效条目不受影响", () => {
    const { db } = fakeDb();
    createModelConfig(db, ok);
    const b = createModelConfig(db, { ...ok, name: "GLM" });
    expect(removeModelConfig(db, b.id)).toBe(true);
    expect(getActiveModelConfig(db)?.name).toBe("DeepSeek 主线");
    expect(listModelConfigs(db)).toHaveLength(1);
  });

  it("删的是生效条目：最新的另一条顶上，目录不空转", () => {
    const { db } = fakeDb();
    const a = createModelConfig(db, ok);
    const b = createModelConfig(db, { ...ok, name: "GLM" });
    activateModelConfig(db, b.id);
    expect(removeModelConfig(db, b.id)).toBe(true);
    const active = getActiveModelConfig(db);
    expect(active?.id).toBe(a.id);
    expect(active?.active).toBe(true);
  });

  it("没这一条：改返回 null、删返回 false、activate 返回 null", () => {
    const { db } = fakeDb();
    expect(updateModelConfig(db, "nope", { name: "x" })).toBeNull();
    expect(removeModelConfig(db, "nope")).toBe(false);
    expect(activateModelConfig(db, "nope")).toBeNull();
  });
});

describe("model_configs 校验", () => {
  it("format 必须是三值之一", () => {
    const { db } = fakeDb();
    expect(() => createModelConfig(db, { ...ok, format: "gemini" })).toThrow(
      /接口格式/,
    );
    expect(() => createModelConfig(db, { ...ok, format: "" })).toThrow(
      /format/,
    );
    const c = createModelConfig(db, ok);
    expect(() => updateModelConfig(db, c.id, { format: "openai" })).toThrow(
      /接口格式/,
    );
    // 合法值放行
    expect(updateModelConfig(db, c.id, { format: "openai-chat" })?.format).toBe(
      "openai-chat",
    );
  });

  it("缺必填：逐项拒", () => {
    const { db } = fakeDb();
    expect(() => createModelConfig(db, { ...ok, name: "  " })).toThrow(/名称/);
    expect(() => createModelConfig(db, { ...ok, baseUrl: "" })).toThrow(
      /baseUrl/,
    );
    expect(() => createModelConfig(db, { ...ok, keySecret: "" })).toThrow(
      /keySecret/,
    );
    expect(() => createModelConfig(db, { ...ok, model: "" })).toThrow(/模型名/);
  });

  it("改成空值同样拒；字段缺省不触发校验", () => {
    const { db } = fakeDb();
    const c = createModelConfig(db, ok);
    expect(() => updateModelConfig(db, c.id, { name: "" })).toThrow(/名称/);
    expect(() => updateModelConfig(db, c.id, { baseUrl: "  " })).toThrow(
      /baseUrl/,
    );
    expect(updateModelConfig(db, c.id, {})?.id).toBe(c.id);
  });
});

describe("model_configs 按 id 取", () => {
  it("getConfigById：在与不在", () => {
    const { db } = fakeDb();
    const c = createModelConfig(db, ok);
    expect(getConfigById(db, c.id)?.id).toBe(c.id);
    expect(getConfigById(db, "nope")).toBeNull();
  });
});
