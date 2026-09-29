// model_configs：模型厂商配置目录。
//
// 以前主线模型只认 Worker secrets 那一套（API_ENDPOINT + API_KEY + API_MODEL），
// 换一家厂商得改配置重新部署。这张表把「用哪家、什么协议、去哪个门」变成数据：
// 管理员在面板上添几条配置、点名哪条生效（active），对话主循环按生效那条建模。
//
// 表只建在主人那间 —— 和 guest_types 一样，这是这张台子的配置，
// 不是哪位来客的私物；来客那间隔着 DO 读得到生效那条（里面本来就没有 key 本体）。
//
// 红线：keySecret 存的是 Worker secret 的**变量名**（如 "DEEPSEEK_KEY"），
// key 本体只活在 secrets 里，绝不落库 —— 所以这张表可以整表回显给面板。

import type { SqlTag } from "./state";

/** 三种接口格式，对应 providers.ts 里三条建模路径 */
export type ModelFormat = "anthropic" | "openai-chat" | "openai-responses";

export const MODEL_FORMATS: ModelFormat[] = [
  "anthropic",
  "openai-chat",
  "openai-responses",
];

export interface ModelConfig {
  id: string;
  name: string;
  format: ModelFormat;
  baseUrl: string;
  /** Worker secret 的变量名（如 "DEEPSEEK_KEY"），不是 key 本体 */
  keySecret: string;
  model: string;
  maxOutput: number;
  /** 维护模型单独走哪把 key；空 = 复用主线那把 */
  maintKeySecret: string;
  /** 维护模型用哪个模型名；空 = 复用主线那个 */
  maintModel: string;
  active: boolean;
}

interface ModelRow {
  id: string;
  name: string;
  format: string;
  base_url: string;
  key_secret: string;
  model: string;
  max_output: number;
  maint_key_secret: string;
  maint_model: string;
  active: number | boolean;
  created: string;
}

export interface ModelConfigInput {
  name: string;
  format: string;
  baseUrl: string;
  keySecret: string;
  model: string;
  maxOutput?: number;
  maintKeySecret?: string;
  maintModel?: string;
}

/** 改配置的入参：字段缺省（undefined）不动 */
export interface ModelConfigPatch {
  name?: string;
  format?: string;
  baseUrl?: string;
  keySecret?: string;
  model?: string;
  maxOutput?: number;
  maintKeySecret?: string;
  maintModel?: string;
  active?: boolean;
}

/** SQLite 的 1/0 和假库里的 true/false 都归一成布尔 */
function toBool(v: number | boolean): boolean {
  return v === 1 || v === true;
}

function rowToConfig(r: ModelRow): ModelConfig {
  return {
    id: r.id,
    name: r.name,
    format: r.format as ModelFormat,
    baseUrl: r.base_url,
    keySecret: r.key_secret,
    model: r.model,
    maxOutput: Number(r.max_output),
    maintKeySecret: r.maint_key_secret,
    maintModel: r.maint_model,
    active: toBool(r.active),
  };
}

function assertFormat(format: string): void {
  if (!MODEL_FORMATS.includes(format as ModelFormat))
    throw new Error(
      `不认识这种接口格式：${format}（只支持 anthropic / openai-chat / openai-responses）`,
    );
}

/**
 * max_output 只认正整数，其余一律回到 32768。
 * 这是旧链用了很多年的值（第三方兼容层会兜底限到 4096，32K 是留够思考加正文的下限），
 * 与其让一个手滑的 0 把整轮对话掐断，不如悄悄回到这个已知能用的数。
 */
export function toMaxOutput(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n > 0 ? n : 32768;
}

export function ensureModelConfigsSchema(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS model_configs (
       id               TEXT PRIMARY KEY,
       name             TEXT NOT NULL,
       format           TEXT NOT NULL,
       base_url         TEXT NOT NULL,
       key_secret       TEXT NOT NULL,
       model            TEXT NOT NULL,
       max_output       INTEGER DEFAULT 32768,
       maint_key_secret TEXT DEFAULT '',
       maint_model      TEXT DEFAULT '',
       active           INTEGER DEFAULT 0,
       created          TEXT
     )`;
  // 深度思考的指向曾在这张表上（deep_config_id 列），后来挪进了主人房的
  // state（回复风格页按模式指派）。老实例把列卸掉，新实例本就没有 —— 都不炸
  try {
    sql`ALTER TABLE model_configs DROP COLUMN deep_config_id`;
  } catch {
    /* 列不存在 */
  }
}

function configById(sql: SqlTag, id: string): ModelConfig | null {
  const rows = sql<ModelRow>`
    SELECT id, name, format, base_url, key_secret, model, max_output,
           maint_key_secret, maint_model, active, created
    FROM model_configs WHERE id = ${id}`;
  return rows.length ? rowToConfig(rows[0]) : null;
}

/** 按 id 取一条。深度思考槽位（state.deepConfigId）解析时用。 */
export function getConfigById(sql: SqlTag, id: string): ModelConfig | null {
  ensureModelConfigsSchema(sql);
  return configById(sql, id);
}

/** 全部配置，旧的在前（created 序）。「顺序」本身没有语义，生效只看 active。 */
export function listModelConfigs(sql: SqlTag): ModelConfig[] {
  ensureModelConfigsSchema(sql);
  return sql<ModelRow>`
    SELECT id, name, format, base_url, key_secret, model, max_output,
           maint_key_secret, maint_model, active, created
    FROM model_configs ORDER BY created`.map(rowToConfig);
}

/** 生效中的那条。activateModelConfig 保证了最多只有一条，取最早那笔兜底。 */
export function getActiveModelConfig(sql: SqlTag): ModelConfig | null {
  ensureModelConfigsSchema(sql);
  const rows = sql<ModelRow>`
    SELECT id, name, format, base_url, key_secret, model, max_output,
           maint_key_secret, maint_model, active, created
    FROM model_configs WHERE active = 1 ORDER BY created`;
  return rows.length ? rowToConfig(rows[0]) : null;
}

/**
 * 新建一条。首个条目自动生效 —— 空目录建出第一条却还得手动点「启用」，
 * 是一段没人需要的「请先配置配置」死循环。
 */
export function createModelConfig(
  sql: SqlTag,
  input: ModelConfigInput,
): ModelConfig {
  ensureModelConfigsSchema(sql);
  const name = (input.name || "").trim().slice(0, 60);
  const format = (input.format || "").trim();
  const baseUrl = (input.baseUrl || "").trim().slice(0, 300);
  const keySecret = (input.keySecret || "").trim().slice(0, 80);
  const model = (input.model || "").trim().slice(0, 120);
  if (!name) throw new Error("模型配置的名称不能为空");
  if (!format) throw new Error("接口格式（format）不能为空");
  assertFormat(format);
  if (!baseUrl) throw new Error("接口地址（baseUrl）不能为空");
  if (!keySecret) throw new Error("存 key 的 secret 名（keySecret）不能为空");
  if (!model) throw new Error("模型名（model）不能为空");
  const first = listModelConfigs(sql).length === 0;
  const row: ModelRow = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    format,
    base_url: baseUrl,
    key_secret: keySecret,
    model,
    max_output: toMaxOutput(input.maxOutput),
    maint_key_secret: (input.maintKeySecret || "").trim().slice(0, 80),
    maint_model: (input.maintModel || "").trim().slice(0, 120),
    active: first ? 1 : 0,
    created: new Date().toISOString(),
  };
  sql`INSERT INTO model_configs (id, name, format, base_url, key_secret,
            model, max_output, maint_key_secret, maint_model, active, created)
      VALUES (${row.id}, ${row.name}, ${row.format}, ${row.base_url},
              ${row.key_secret}, ${row.model}, ${row.max_output},
              ${row.maint_key_secret}, ${row.maint_model}, ${row.active},
              ${row.created})`;
  return rowToConfig(row);
}

export function updateModelConfig(
  sql: SqlTag,
  id: string,
  patch: ModelConfigPatch,
): ModelConfig | null {
  ensureModelConfigsSchema(sql);
  const cur = configById(sql, id);
  if (!cur) return null;
  const name =
    patch.name === undefined
      ? cur.name
      : String(patch.name).trim().slice(0, 60);
  if (!name) throw new Error("模型配置的名称不能为空");
  let format: string = cur.format;
  if (patch.format !== undefined) {
    format = String(patch.format).trim();
    if (!format) throw new Error("接口格式（format）不能为空");
    assertFormat(format);
  }
  const baseUrl =
    patch.baseUrl === undefined
      ? cur.baseUrl
      : String(patch.baseUrl).trim().slice(0, 300);
  if (!baseUrl) throw new Error("接口地址（baseUrl）不能为空");
  const keySecret =
    patch.keySecret === undefined
      ? cur.keySecret
      : String(patch.keySecret).trim().slice(0, 80);
  if (!keySecret) throw new Error("存 key 的 secret 名（keySecret）不能为空");
  const model =
    patch.model === undefined
      ? cur.model
      : String(patch.model).trim().slice(0, 120);
  if (!model) throw new Error("模型名（model）不能为空");
  sql`UPDATE model_configs SET name = ${name}, format = ${format},
        base_url = ${baseUrl}, key_secret = ${keySecret}, model = ${model},
        max_output = ${toMaxOutput(
          patch.maxOutput === undefined ? cur.maxOutput : patch.maxOutput,
        )},
        maint_key_secret = ${
          patch.maintKeySecret === undefined
            ? cur.maintKeySecret
            : String(patch.maintKeySecret).trim().slice(0, 80)
        },
        maint_model = ${
          patch.maintModel === undefined
            ? cur.maintModel
            : String(patch.maintModel).trim().slice(0, 120)
        },
        active = ${patch.active === undefined ? toBoolFrom(cur.active) : patch.active ? 1 : 0}
      WHERE id = ${id}`;
  return configById(sql, id);
}

/** 布尔入 SQL 前归一；写在上面那句话太挤，拆出来 */
function toBoolFrom(v: number | boolean): number {
  return toBool(v) ? 1 : 0;
}

export function removeModelConfig(sql: SqlTag, id: string): boolean {
  ensureModelConfigsSchema(sql);
  const rows = sql<{ id: string; active: number | boolean }>`
    SELECT id, active FROM model_configs WHERE id = ${id}`;
  if (!rows.length) return false;
  const wasActive = toBool(rows[0].active);
  sql`DELETE FROM model_configs WHERE id = ${id}`;
  if (wasActive) {
    // 删的是生效那条：把剩下最新的顶上来 —— 目录永远要有一个可用项，
    // 否则「删一条旧配置」这个无害动作会让整台机器退回 secrets 链，没人知道为什么。
    const rest = listModelConfigs(sql);
    if (rest.length) activateModelConfig(sql, rest[rest.length - 1].id);
  }
  return true;
}

/**
 * 点名生效，先全清再置一。两条 UPDATE 顺序执行即可 ——
 * DO 单线程处理请求，这两句之间不会插进别的写入，等价于事务。
 */
export function activateModelConfig(
  sql: SqlTag,
  id: string,
): ModelConfig | null {
  ensureModelConfigsSchema(sql);
  if (!configById(sql, id)) return null;
  sql`UPDATE model_configs SET active = 0`;
  sql`UPDATE model_configs SET active = 1 WHERE id = ${id}`;
  return configById(sql, id);
}
