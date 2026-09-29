// AI SDK model provider 工厂。
//
// 两条建模的路：
// - 目录链（model_configs，管理员面板配的）：生效条目说用哪家、什么协议、
//   去哪个门，key 从该条目点名的 secret 变量名取；
// - 旧链（Worker secrets）：API_ENDPOINT 是 Anthropic 兼容端点（如
//   https://api.deepseek.com/anthropic）。注意 AI SDK 只会在 baseURL 后面补一个
//   /messages，**不会**补 /v1 —— 所以端点的 /v1 要自己带上（DeepSeek 恰好
//   /anthropic 与 /anthropic/v1 都收，少写一层看不出来；换成小米 MiMo 就直接 404）。
//
// AI Gateway 只属于旧链：目录条目不带网关概念，baseUrl 里用户自己可以填网关地址。

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { mimoAnthropicBase } from "./mimo";
import {
  toMaxOutput,
  type ModelConfig,
  type ModelFormat,
} from "./agent/modelConfigs";

export const DEFAULT_MODEL = "claude-sonnet-4-20250514";

function provider(env: Env, apiKey: string) {
  // 走 AI Gateway 时用网关地址，并开启 1 小时结果缓存省 token
  const gateway = env.AI_GATEWAY_URL;
  return createAnthropic({
    baseURL: gateway || env.API_ENDPOINT || "https://api.anthropic.com",
    apiKey,
    headers: gateway ? { "cf-aig-cache-ttl": "3600" } : undefined,
  });
}

/** 主对话模型；未配置 API_KEY 时返回 null，由调用方给出明确提示。 */
export function mainModel(env: Env): LanguageModel | null {
  if (!env.API_KEY) return null;
  return provider(env, env.API_KEY)(env.API_MODEL || DEFAULT_MODEL);
}

/** 后台维护模型（夜间整理 / 反思 / 洞察萃取）；缺省复用主模型。 */
export function maintenanceModel(env: Env): LanguageModel | null {
  if (env.SK_MAINTENANCE)
    return provider(env, env.SK_MAINTENANCE)(env.API_MODEL || DEFAULT_MODEL);
  return mainModel(env);
}

/** 起会话标题用的模型；不填就用小米的 MiMo V2.5 Pro */
export const DEFAULT_TITLE_MODEL = "mimo-v2.5-pro";

/**
 * 起标题的模型：小米 MiMo，走它自己的 Anthropic 兼容端点（见 src/mimo.ts）。
 *
 * 为什么不复用 maintenanceModel：起标题是「一句话的小活」，主线那台模型
 * 是按量计费的，用它等于拿大炮打蚊子。MiMo 这边是包月套餐，这类碎活正好塞进去。
 *
 * 没配 MIMO_API_KEY 时返回 null，标题就保持原来的「截前 18 个字」。
 */
export function titleModel(env: Env): LanguageModel | null {
  if (!env.MIMO_API_KEY) return null;
  return createAnthropic({
    baseURL: mimoAnthropicBase(env),
    apiKey: env.MIMO_API_KEY,
    // 不挂 AI Gateway：网关的缓存与限额是给主线那台模型配的，这里用不上
  })((env.MIMO_TITLE_MODEL || "").trim() || DEFAULT_TITLE_MODEL);
}

/**
 * 起标题时要一起传下去的参数：关掉思考。
 *
 * mimo-v2.5-pro 默认先想一遍再开口。起个名字用不着推理 ——
 * 实测 881 个字符的思考换来一个名字，而关掉之后它直接给，
 * 既不白等那几秒，也不白烧套餐额度。
 * 放在这里而不是散在调用处：这是这家模型的脾气，该跟选模型的地方待在一起。
 */
export const TITLE_PROVIDER_OPTIONS = {
  anthropic: { thinking: { type: "disabled" } },
} as const;

// ── 目录链：按 model_configs 的生效条目建模 ─────────────────

/** 一次解析的结果：主模型 + 输出上限 + 维护模型（后者不可能为 null） */
export interface ResolvedModel {
  model: LanguageModel;
  maxOutput: number;
  maintModel: LanguageModel | null;
}

/** 从 env 里按变量名取 secret；不是字符串一律当没配 */
function envSecret(env: Env, name: string): string {
  const v = (env as unknown as Record<string, unknown>)[name || ""];
  return typeof v === "string" ? v : "";
}

/** 按目录条目的格式建一个模型。baseUrl 原样透传 —— 路径语义由 AI SDK 自己补。 */
function buildModel(
  format: ModelFormat,
  baseUrl: string,
  apiKey: string,
  modelId: string,
): LanguageModel {
  if (format === "anthropic")
    return createAnthropic({ baseURL: baseUrl, apiKey })(modelId);
  const openai = createOpenAI({ apiKey, baseURL: baseUrl });
  // .chat 是 chat completions；默认调用在 v6 里是 responses 语义，必须显式选
  return format === "openai-responses"
    ? openai.responses(modelId)
    : openai.chat(modelId);
}

/**
 * 把「这一轮该用哪个模型」定下来。
 *
 * fetchActive 去主人那间读 model_configs 的生效条目（调用方负责缓存），
 * 读到了且它点名的 key 在这台机器上真的配了，就走目录链；
 * 读不到、key 缺了、中途出错 —— 一律回落旧链。换厂商是锦上添花，
 * 不能因为目录那边出任何岔子让整台机器说不了话。
 */
export async function resolveModel(
  env: Env,
  fetchActive: () => Promise<ModelConfig | null>,
): Promise<ResolvedModel | null> {
  let cfg: ModelConfig | null = null;
  try {
    cfg = await fetchActive();
  } catch {
    cfg = null;
  }

  if (cfg) {
    const apiKey = envSecret(env, cfg.keySecret);
    if (apiKey) {
      const model = buildModel(cfg.format, cfg.baseUrl, apiKey, cfg.model);
      // 维护模型：单独配了 key 就另建一个；只写了模型名没写 key 不算数 ——
      // 用主线那把 key 去调另一个模型名，多半是没开通，报错只会更难查。
      const maintKey = cfg.maintKeySecret
        ? envSecret(env, cfg.maintKeySecret)
        : "";
      const maintModel = maintKey
        ? buildModel(
            cfg.format,
            cfg.baseUrl,
            maintKey,
            cfg.maintModel || cfg.model,
          )
        : model;
      return {
        model,
        maxOutput: toMaxOutput(cfg.maxOutput),
        maintModel,
      };
    }
    // 只提醒一行：目录条目配了但这台机器没那把钥匙，是迁移期最常见的状态
    console.warn(
      `[model-configs] 配置「${cfg.name}」点名的 ${cfg.keySecret} 没配 key，回落到内置配置`,
    );
  }

  const model = mainModel(env);
  if (!model) return null;
  return { model, maxOutput: 32768, maintModel: maintenanceModel(env) };
}
