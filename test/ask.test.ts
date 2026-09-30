/**
 * 提问卡测试。
 *
 * 测的是「记账」那一半：哪一句会被写成一张卡、写到哪一场、什么时候不该再写。
 * 「这一句该不该问」是语义判断，归模型 —— 测不了也不该测。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import {
  INITIAL_STATE,
  type AskEntry,
  type ChatState,
} from "../src/agent/state";
import { askTools } from "../src/tools/ask";
import type { ToolCtx } from "../src/tools/types";

/** 只搭出 ask 工具用到的那两样：state 快照和 patchState */
function makeCtx(seed: Partial<ChatState> = {}) {
  const patches: Array<Partial<ChatState>> = [];
  const ctx = {
    state: { ...INITIAL_STATE, ...seed },
    patchState(p: Partial<ChatState>) {
      patches.push(p);
      Object.assign(ctx.state, p);
    },
  } as unknown as ToolCtx;
  return { ctx, patches };
}

/** ask 是原生 AI SDK tool；这里只喂输入，不管它第二个参数 */
function askOf(ctx: ToolCtx) {
  const t = askTools(ctx).ask as unknown as {
    execute: (a: unknown) => Promise<string>;
  };
  return (a: { question: string; options?: string[]; why?: string }) =>
    t.execute(a);
}

const card = (over: Partial<AskEntry> = {}): AskEntry => ({
  id: "old-" + Math.random().toString(36).slice(2),
  text: "用哪个版本",
  options: [],
  why: "",
  askedAt: "2026-09-19T10:00:00.000Z",
  sessionId: "s1",
  ...over,
});

describe("ask 工具", () => {
  it("问一句就写一张卡，落在当前这一场", async () => {
    const { ctx, patches } = makeCtx({ activeSession: "s1" });
    const out = await askOf(ctx)({
      question: "说明书要写成给谁看的？",
      options: ["给同事", "给用户"],
      why: "语气差很远",
    });

    expect(patches).toHaveLength(1);
    expect(ctx.state.asks).toHaveLength(1);
    expect(ctx.state.asks[0]).toMatchObject({
      text: "说明书要写成给谁看的？",
      options: ["给同事", "给用户"],
      why: "语气差很远",
      sessionId: "s1",
    });
    // 回给模型的话要让它知道「停下来等他」，不能当成交完事了
    expect(out).toContain("等他答");
  });

  it("空问题不写卡 —— 一张没内容的卡片只会让人莫名其妙", async () => {
    const { ctx, patches } = makeCtx({ activeSession: "s1" });
    await askOf(ctx)({ question: "   " });
    expect(patches).toHaveLength(0);
    expect(ctx.state.asks).toHaveLength(0);
  });

  it("同一句话不重复问：那不是催，是噪音", async () => {
    const { ctx, patches } = makeCtx({
      activeSession: "s1",
      asks: [card({ text: "用哪个版本" })],
    });
    const out = await askOf(ctx)({ question: "用哪个版本" });
    expect(patches).toHaveLength(0);
    expect(out).toContain("已经摆在他面前");
  });

  it("一场里压满三个就不再叠了，让它自己拿个主意", async () => {
    const { ctx, patches } = makeCtx({
      activeSession: "s1",
      asks: [card({ text: "a" }), card({ text: "b" }), card({ text: "c" })],
    });
    const out = await askOf(ctx)({ question: "第四个问题" });
    expect(patches).toHaveLength(0);
    expect(out).toContain("先别再叠");
  });

  it("别场里没答的问题不算这一场的 —— 上限是按对话算的，不是全局", async () => {
    const { ctx, patches } = makeCtx({
      activeSession: "s2",
      asks: [
        card({ text: "a", sessionId: "s1" }),
        card({ text: "b", sessionId: "s1" }),
        card({ text: "c", sessionId: "s1" }),
      ],
    });
    await askOf(ctx)({ question: "这场的第一问" });
    expect(patches).toHaveLength(1);
    expect(ctx.state.asks).toHaveLength(4);
  });

  it("阻塞式：挂起等作答，回答作为工具结果回喂，同一轮接着跑", async () => {
    const waiters = new Map<string, (a: string) => void>();
    const { ctx } = makeCtx({ activeSession: "s1" });
    (
      ctx as unknown as {
        waitForAsk: (id: string, onAnswer: (a: string) => void) => void;
      }
    ).waitForAsk = (id: string, onAnswer: (a: string) => void) => {
      waiters.set(id, onAnswer);
    };
    const ask = askTools(ctx).ask as unknown as {
      execute: (a: unknown) => Promise<string>;
    };

    const pending = ask.execute({
      question: "走哪条路？",
      options: ["A", "B"],
    });
    // 挂起期间 promise 未决：模型停在这一步等答案
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    expect(waiters.size).toBe(1);

    // 他答了：答案作为工具结果回来（「他的回答：」的包装在 cowork.resolveAsk 那层）
    const [id, resolve] = [...waiters.entries()][0];
    resolve("走 B");
    const out = await pending;
    expect(out).toBe("问到了：「走哪条路？」（给了 2 个选项）。走 B");
    expect(id).toBeTruthy();
  });

  it("先不答（空答案）：不追加任何回答，交给上层按「自己拿主意」回喂", async () => {
    const waiters = new Map<string, (a: string) => void>();
    const { ctx } = makeCtx({ activeSession: "s1" });
    (
      ctx as unknown as {
        waitForAsk: (id: string, onAnswer: (a: string) => void) => void;
      }
    ).waitForAsk = (id: string, onAnswer: (a: string) => void) => {
      waiters.set(id, onAnswer);
    };
    const ask = askTools(ctx).ask as unknown as {
      execute: (a: unknown) => Promise<string>;
    };
    const pending = ask.execute({ question: "授权我发吗？" });
    const [, resolve] = [...waiters.entries()][0];
    resolve("");
    const out = await pending;
    expect(out).toBe("问到了：「授权我发吗？」。");
  });
});
