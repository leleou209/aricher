/**
 * 思考流实时性探测：慢速 SSE（每块 150ms）喂桥，量 reasoning-delta 的到达节奏。
 * 桥层若攒批（间隔 ≈ 总时长），问题在桥；若实时（间隔 ≈ 150ms），问题在更上层。
 * 运行: npx vitest run test/reasoningBridgeTiming.test.ts
 */

import { describe, expect, it, vi } from "vitest";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { openAIModelWithReasoning } from "../src/agent/reasoningBridge";

function slowSseResponse(blocks: string[], gapMs: number): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      for (const b of blocks) {
        ctrl.enqueue(enc.encode(b));
        await new Promise((r) => setTimeout(r, gapMs));
      }
      ctrl.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("思考流实时性", () => {
  it("reasoning-delta 逐块到达，不攒团", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        slowSseResponse(
          Array.from(
            { length: 6 },
            (_, i) =>
              `data: {"choices":[{"index":0,"delta":{"reasoning_content":"片${i}"}}]}\n\n`,
          ),
          150,
        ),
      ),
    );
    const model = openAIModelWithReasoning({
      apiKey: "k",
      baseURL: "https://fake.test/v1",
      format: "openai-chat",
      modelId: "m",
    });
    const res = await (
      model as unknown as {
        doStream: (
          o: unknown,
        ) => Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }>;
      }
    ).doStream({
      prompt: [],
    } as unknown as LanguageModelV3CallOptions);
    const reader = res.stream.getReader();
    const t0 = Date.now();
    const gaps: number[] = [];
    let last = Date.now();
    let reasoningCount = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const v = value as LanguageModelV3StreamPart;
      console.log("[dbg] read ->", v.type, Date.now() % 100000);
      if (v.type === "reasoning-delta") {
        const now = Date.now();
        gaps.push(now - last);
        last = now;
        reasoningCount++;
      }
    }
    vi.unstubAllGlobals();
    console.log("[timing] reasoning-delta 间隔:", gaps.join(", "), "ms");
    console.log("[timing] 总数:", reasoningCount);
    // 6 块每块 150ms：若实时，间隔应接近 150ms（±80ms 容忍）；
    // 若攒团，会看到一次 ≥ 900ms 的大间隔
    expect(reasoningCount).toBe(6);
    const bigGap = gaps.filter((g) => g > 400);
    expect(bigGap).toEqual([]);
  }, 15000);
});
