// call_tool 网关的行为钉子：分发、probe、参数自纠、错误回喂。
// 网关是渐进式披露的咽喉——它把参数弄丢、把错误吞了，模型就会在错误的路上越走越远。
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { gatewayTools } from "../src/tools/gateway";

/** 网关返回的 call_tool 是原生 AI SDK tool；只喂输入，不管 execute 的第二个参数 */
function callOf(
  deferred: Record<string, unknown>,
  onDeferredUse?: (name: string, ok: boolean, ms: number) => void,
  promoted: string[] = [],
) {
  const g = gatewayTools(
    deferred as never,
    onDeferredUse ? { onDeferredUse } : {},
    promoted,
  );
  return (
    g.call_tool as unknown as {
      execute: (a: {
        tool: string;
        args?: Record<string, unknown>;
      }) => Promise<string>;
    }
  ).execute;
}

function fakeTool(over: Record<string, unknown> = {}) {
  return {
    description: "测试工具：把数字念出来",
    inputSchema: z.object({ n: z.number() }),
    execute: vi.fn(async ({ n }: { n: number }) => `念：${n}`),
    ...over,
  };
}

describe("call_tool 网关", () => {
  it("正常分发：args 过了 zod 就透传给真工具，结果原样带回", async () => {
    const t = fakeTool();
    const calls: Array<[string, boolean, number]> = [];
    const out = await callOf({ t1: t }, (n, ok, ms) => calls.push([n, ok, ms]))(
      { tool: "t1", args: { n: 7 } },
    );
    expect(out).toBe("念：7");
    expect(t.execute).toHaveBeenCalledWith({ n: 7 });
    expect(calls).toEqual([["t1", true, expect.any(Number)]]);
  });

  it("probe：只传 tool 不传 args，回完整定义、不执行", async () => {
    const t = fakeTool();
    const out = await callOf({ t1: t })({ tool: "t1" });
    expect(out).toContain("测试工具：把数字念出来");
    expect(out).toContain("参数定义");
    expect(t.execute).not.toHaveBeenCalled();
  });

  it("参数没对上：错误和完整定义一起回喂，让模型同场自纠", async () => {
    const t = fakeTool();
    const out = await callOf({ t1: t })({ tool: "t1", args: { n: "七" } });
    expect(out).toContain("参数没对上");
    expect(out).toContain("测试工具：把数字念出来");
    expect(t.execute).not.toHaveBeenCalled();
  });

  it("索引里没有的名字：人话报错，不碰任何工具", async () => {
    const t = fakeTool();
    const out = await callOf({ t1: t })({ tool: "nope", args: { n: 1 } });
    expect(out).toContain("没有「nope」");
    expect(t.execute).not.toHaveBeenCalled();
  });

  it("已转正的工具：指引直接调用，不把存在的工具报成不存在", async () => {
    const t = fakeTool();
    // memory 转正后不在 deferred 里，但模型照着旧索引经网关调它 —— 最容易混淆的那条路
    const out = await callOf({ t1: t }, undefined, ["memory"])({
      tool: "memory",
      args: { action: "stats" },
    });
    expect(out).toContain("已经转成常驻工具");
    expect(out).toContain("直接调用");
    expect(t.execute).not.toHaveBeenCalled();
  });

  it("参数没对上也记账：onDeferredUse 收到 false，空转不算用得顺手", async () => {
    const t = fakeTool();
    const calls: Array<[string, boolean, number]> = [];
    const out = await callOf({ t1: t }, (n, ok) => calls.push([n, ok, 0]))({
      tool: "t1",
      args: { n: "七" },
    });
    expect(out).toContain("参数没对上");
    expect(calls).toEqual([["t1", false, 0]]);
  });

  it("真工具抛错：错误回喂成文字，账记成失败，不炸轮", async () => {
    const t = fakeTool({
      execute: vi.fn(async () => {
        throw new Error("桶炸了");
      }),
    });
    const calls: Array<[string, boolean, number]> = [];
    const out = await callOf({ t1: t }, (n, ok) => calls.push([n, ok, 0]))({
      tool: "t1",
      args: { n: 1 },
    });
    expect(out).toContain("执行出错");
    expect(out).toContain("桶炸了");
    expect(calls[0][1]).toBe(false);
  });

  it("非字符串返回值：JSON 序列化后再回", async () => {
    const t = fakeTool({
      execute: vi.fn(async () => ({ ok: true, rows: 3 })),
    });
    const out = await callOf({ t1: t })({ tool: "t1", args: { n: 1 } });
    expect(JSON.parse(out)).toEqual({ ok: true, rows: 3 });
  });
});
