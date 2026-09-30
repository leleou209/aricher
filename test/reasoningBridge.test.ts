/**
 * 思考流桥测试（reasoningBridge）—— 端到端形态。
 *
 * 桥现场建 openai provider 并拦截 fetch：stub 全局 fetch 返回构造的 SSE，
 * 让真 provider 完整跑一遍解析，验证 reasoning_content /
 * response.reasoning_text.delta 被合成为 reasoning 事件、正文原样、
 * 半包 JSON 可拼、无思维链时零影响。
 *
 * 运行: npx vitest run
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { openAIModelWithReasoning } from "../src/agent/reasoningBridge";

function sseResponse(sse: string, chunkSize = Infinity): Response {
  const bytes = new TextEncoder().encode(sse);
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        ctrl.enqueue(bytes.slice(i, i + chunkSize));
      ctrl.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(
  format: "openai-chat" | "openai-responses",
  sse: string,
  chunkSize = Infinity,
): Promise<LanguageModelV3StreamPart[]> {
  const model = openAIModelWithReasoning({
    apiKey: "k",
    baseURL: "https://fake.test/v1",
    format,
    modelId: "m",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sseResponse(sse, chunkSize)),
  );
  const res = await (
    model as unknown as {
      doStream: (
        o: LanguageModelV3CallOptions,
      ) => Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }>;
    }
  ).doStream({
    prompt: [],
  } as unknown as LanguageModelV3CallOptions);
  const reader = res.stream.getReader();
  const out: LanguageModelV3StreamPart[] = [];
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const CHAT_SSE =
  'data: {"choices":[{"index":0,"delta":{"reasoning_content":"先"}}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"reasoning_content":"想想"}}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{"content":"答案"}}]}\n\n' +
  "data: [DONE]\n\n";

describe("思考流桥（openAIModelWithReasoning）", () => {
  it("chat：reasoning_content 分片合成 reasoning 事件，先于正文", async () => {
    const out = await collect("openai-chat", CHAT_SSE);
    const kinds = out.map((e) => e.type);
    expect(kinds).toContain("reasoning-start");
    expect(kinds).toContain("reasoning-end");
    expect(kinds.indexOf("reasoning-start")).toBeLessThan(
      kinds.indexOf("text-delta"),
    );
    const deltas = out
      .filter((e) => e.type === "reasoning-delta")
      .map((e) => (e as { delta: string }).delta);
    expect(deltas.join("")).toBe("先想想");
    expect(out.some((e) => e.type === "text-delta" && e.delta === "答案")).toBe(
      true,
    );
  });

  it("半包 JSON：reasoning 分片跨 SSE 块也能拼回来", async () => {
    const out = await collect("openai-chat", CHAT_SSE, 7);
    const deltas = out
      .filter((e) => e.type === "reasoning-delta")
      .map((e) => (e as { delta: string }).delta);
    expect(deltas.join("")).toBe("先想想");
    expect(out.some((e) => e.type === "text-delta" && e.delta === "答案")).toBe(
      true,
    );
  });

  it("responses：reasoning_text.delta 事件也认", async () => {
    const sse =
      'data: {"type":"response.reasoning_text.delta","item_id":"i1","output_index":0,"content_index":0,"delta":"琢磨中"}\n\n' +
      'data: {"type":"response.output_text.delta","item_id":"i1","output_index":0,"content_index":0,"delta":"正文"}\n\n';
    const out = await collect("openai-responses", sse);
    const deltas = out
      .filter((e) => e.type === "reasoning-delta")
      .map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(["琢磨中"]);
    expect(out.some((e) => e.type === "text-delta")).toBe(true);
  });

  it("doGenerate：thinker 的非流式调用从流式实现聚合出全文", async () => {
    const model = openAIModelWithReasoning({
      apiKey: "k",
      baseURL: "https://fake.test/v1",
      format: "openai-chat",
      modelId: "m",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(CHAT_SSE)),
    );
    const res = await (
      model as unknown as {
        doGenerate: (o: unknown) => Promise<{
          content: Array<{ type: string; text?: string }>;
        }>;
      }
    ).doGenerate({ prompt: [] });
    expect(res.content.map((c) => c.text ?? "").join("")).toBe("答案");
    vi.unstubAllGlobals();
  });
  it("没有思维链的端点零影响：事件原样穿过", async () => {
    const sse =
      'data: {"choices":[{"index":0,"delta":{"content":"直接答"}}]}\n\n';
    const out = await collect("openai-chat", sse);
    console.log(
      "[dbg] events:",
      JSON.stringify(out.map((e) => e.type)),
      (
        out.find((e) => e.type === "error") as unknown as {
          error?: { message?: string };
        }
      )?.error?.message ?? "",
    );
    expect(out.some((e) => e.type === "text-delta")).toBe(true);
    expect(out.some((e) => e.type === "reasoning-start")).toBe(false);
  });
});
