// 小米 MiMo 的两套凭证指向两个不同的门 —— 这一层只回答这一个问题。
//
// 为什么要单独拎出来：官方把「按量付费」和「Token Plan」做成了两套互不通用的 key
// （sk-xxxxx 走 api.xiaomimimo.com，tp-xxxxx 走 token-plan-cn.xiaomimimo.com），
// 而用错门的报错一模一样，都是 401 Invalid API Key。
// 光看报错永远查不出原因，只能靠前缀分路。这件事只写在这一处，
// 语音合成和标题生成共用 —— 免得哪一天两边走岔，又得从头查一遍。

/** Token Plan（tp- 开头）的中国集群 */
const PLAN_HOST = "https://token-plan-cn.xiaomimimo.com";
/** 按量付费（sk- 开头） */
const PUBLIC_HOST = "https://api.xiaomimimo.com";

/** 这串 key 该去哪个门。前缀是官方写死的格式，照着分就行。 */
export function mimoHost(env: Env): string {
  return (env.MIMO_API_KEY || "").startsWith("tp-") ? PLAN_HOST : PUBLIC_HOST;
}

/** OpenAI 兼容的对话补全地址（语音合成走这条）。MIMO_TTS_URL 只有第三方转发站才需要填。 */
export function mimoChatUrl(env: Env): string {
  return (
    (env.MIMO_TTS_URL || "").trim() || `${mimoHost(env)}/v1/chat/completions`
  );
}

/**
 * Anthropic 兼容的根地址（文字生成走这条）。
 *
 * /v1 必须自己带上：AI SDK 的 anthropic provider 只在后面补一个 /messages，
 * 不会替你补 /v1。少了它小米这边直接 404 Not Found（DeepSeek 那边恰好两个都收，
 * 所以照抄主线那套配置会踩坑）。
 */
export function mimoAnthropicBase(env: Env): string {
  return (env.MIMO_API_BASE || "").trim() || `${mimoHost(env)}/anthropic/v1`;
}
