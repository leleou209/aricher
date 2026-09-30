/**
 * 绘图配置目录（draw_configs）测试。
 *
 * 这张表管的是「出图三档各用哪家、哪个模型、哪把钥匙」——以前写死在
 * draw.ts 里的那三条常量。这里验：
 * - 首次建表种入三条内置默认：没配置过的机器行为和配置化之前一字不差；
 * - 再 ensure 不重复种（管理员改过的档位不能被默认值洗回去）；
 * - 改一档往返：models 数组折成逗号串存、读回拆开；字段缺省不动；
 * - format 三值校验、models 全空拒、tier 非法返回 null，拒的时候要听得懂；
 * - 行损坏（format 不认识）回落那档默认，画图不至于断路。
 *
 * 表用最小假 SQL 引擎，只认得 drawConfigs.ts 会发的那几条语句。
 *
 * 运行: npx vitest run test/drawConfigs.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_DRAW_CONFIGS,
  ensureDrawConfigsSchema,
  listDrawConfigs,
  resolveDrawTiers,
  updateDrawConfig,
} from "../src/agent/drawConfigs";
import type { SqlTag } from "../src/agent/state";

interface Row {
  tier: string;
  format: string;
  endpoint: string;
  models: string;
  key_secret: string;
  label: string;
}

/** 最小假 SQL 引擎：行存成 snake_case，语句按前缀认 */
function fakeDb() {
  const rows: Row[] = [];

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table")) return [] as T[];

    if (sql.startsWith("select count(*) as n from draw_configs")) {
      return [{ n: rows.length }] as T[];
    }

    if (sql.startsWith("insert into draw_configs")) {
      const [tier, format, endpoint, models, key_secret, label] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      rows.push({ tier, format, endpoint, models, key_secret, label });
      return [] as T[];
    }

    if (sql.startsWith("select tier, format, endpoint")) {
      return [...rows] as T[];
    }

    if (sql.startsWith("update draw_configs set")) {
      const [format, endpoint, models, key_secret, label, tier] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const row = rows.find((r) => r.tier === tier);
      if (!row) throw new Error("假库：update 没找到行");
      Object.assign(row, { format, endpoint, models, key_secret, label });
      return [] as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return { db, rows };
}

describe("默认种子", () => {
  it("首次建表种入三条内置默认：行为和配置化之前一字不差", () => {
    const { db } = fakeDb();
    const tiers = resolveDrawTiers(db);
    expect(tiers.fast).toMatchObject({
      format: "workers-ai",
      models: ["@cf/black-forest-labs/flux-2-klein-4b"],
      label: "FLUX.2 klein",
      keySecret: "",
    });
    expect(tiers.high).toMatchObject({
      format: "siliconflow",
      endpoint: "https://api.siliconflow.cn/v1/images/generations",
      keySecret: "SILICONFLOW_API_KEY",
      label: "硅基流动",
    });
    expect(tiers.fallback).toMatchObject({
      format: "zhipu",
      keySecret: "ZHIPU_KEY",
      label: "智谱",
    });
    // 高质量档的降级顺序：Z-Image 在前，Kolors 退在后面当备胎
    expect(tiers.high.models).toEqual([
      "Tongyi-MAI/Z-Image-Turbo",
      "Kwai-Kolors/Kolors",
    ]);
  });

  it("再 ensure 不重复种：已有的行原样保留", () => {
    const { db } = fakeDb();
    ensureDrawConfigsSchema(db);
    updateDrawConfig(db, "fast", { label: "我的图" });
    ensureDrawConfigsSchema(db);
    expect(listDrawConfigs(db).find((c) => c.tier === "fast")?.label).toBe(
      "我的图",
    );
  });

  it("行损坏（format 不认识）回落那档默认，画图不断路", () => {
    const { db, rows } = fakeDb();
    ensureDrawConfigsSchema(db);
    const high = rows.find((r) => r.tier === "high")!;
    high.format = "alien";
    const list = listDrawConfigs(db);
    expect(list.find((c) => c.tier === "high")).toEqual(
      DEFAULT_DRAW_CONFIGS.high,
    );
    // 别的档不受牵连
    expect(list.find((c) => c.tier === "fast")?.format).toBe("workers-ai");
  });
});

describe("改一档", () => {
  it("改档位往返：models 数组折成逗号串存、读回拆开；缺省字段不动", () => {
    const { db } = fakeDb();
    ensureDrawConfigsSchema(db);
    const up = updateDrawConfig(db, "high", {
      models: ["ACME/Img-1", "ACME/Img-2"],
      endpoint: "https://api.acme.test/v1/images",
      keySecret: "ACME_KEY",
    });
    expect(up?.models).toEqual(["ACME/Img-1", "ACME/Img-2"]);
    expect(up?.endpoint).toBe("https://api.acme.test/v1/images");
    expect(up?.keySecret).toBe("ACME_KEY");
    // 缺省的 format / label 原样保留
    expect(up?.format).toBe("siliconflow");
    expect(up?.label).toBe("硅基流动");
  });

  it("format 三值校验，不认识的拒", () => {
    const { db } = fakeDb();
    ensureDrawConfigsSchema(db);
    expect(() =>
      updateDrawConfig(db, "fast", { format: "midjourney" }),
    ).toThrow(/不认识这种出图协议/);
  });

  it("models 全空拒：一档没有模型名等于瞎了", () => {
    const { db } = fakeDb();
    ensureDrawConfigsSchema(db);
    expect(() => updateDrawConfig(db, "fast", { models: [" ", ""] })).toThrow(
      /至少要留一个模型名/,
    );
  });

  it("tier 不是三档之一返回 null", () => {
    const { db } = fakeDb();
    ensureDrawConfigsSchema(db);
    expect(updateDrawConfig(db, "premium", { label: "x" })).toBeNull();
  });
});
