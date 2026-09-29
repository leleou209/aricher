/**
 * 另开一场说话的测试。
 *
 * 测的是「投递」那一半：现在开还是到点开、开的时候带没带上那一场的名字。
 * 「这件事值不值得单开一场」是语义判断，归模型 —— 测不了也不该测。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import type { Reminder } from "../src/agent/reminderStore";
import type { SessionMeta } from "../src/agent/sessionStore";
import { sessionTools } from "../src/tools/session";
import type { ToolCtx } from "../src/tools/types";

type OpenCall = { content: string; title?: string };
type ScheduleCall = {
  what: string;
  at: string;
  every: string;
  urgent: boolean;
  mode?: string;
  title?: string;
};

/** 只搭出这个工具用到的那两样：现在开、到点开 */
function makeCtx() {
  const opened: OpenCall[] = [];
  const scheduled: ScheduleCall[] = [];
  const ctx = {
    openSession: async (input: OpenCall) => {
      opened.push(input);
      return {
        id: "s-new",
        title: input.title || "",
      } as unknown as SessionMeta;
    },
    scheduleReminder: async (input: ScheduleCall) => {
      scheduled.push(input);
      return {} as Reminder;
    },
  } as unknown as ToolCtx;
  return { ctx, opened, scheduled };
}

/** 原生 AI SDK tool；这里只喂输入，不管它第二个参数 */
function openOf(ctx: ToolCtx) {
  const t = sessionTools(ctx).openSession as unknown as {
    execute: (a: unknown) => Promise<string>;
  };
  return (a: { title: string; content: string; at?: string; every?: string }) =>
    t.execute(a);
}

describe("openSession 工具", () => {
  it("不填时间就是现在开，回话里带上那一场的名字", async () => {
    const { ctx, opened, scheduled } = makeCtx();
    const out = await openOf(ctx)({
      title: "图片都换了",
      content: "那批封面我重新画了一遍，你哪天有空看一眼。",
    });

    expect(opened).toHaveLength(1);
    expect(opened[0].title).toBe("图片都换了");
    expect(scheduled).toHaveLength(0);
    expect(out).toContain("图片都换了");
  });

  it("填了时间就是到点再开：得带上 mode=new，否则会变成「回原来那一场说」", async () => {
    const { ctx, opened, scheduled } = makeCtx();
    await openOf(ctx)({
      title: "月度回顾",
      content: "这个月的账我理完了。",
      at: "2026-10-01T09:00:00+08:00",
    });

    expect(opened).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      mode: "new",
      title: "月度回顾",
      urgent: false,
    });
  });

  it("名字和正文缺一个都不开 —— 没名字的那一场，他在列表里认不出来", async () => {
    const { ctx, opened, scheduled } = makeCtx();
    expect(await openOf(ctx)({ title: "  ", content: "有内容" })).toContain(
      "title",
    );
    expect(await openOf(ctx)({ title: "有名字", content: "   " })).toContain(
      "content",
    );
    expect(opened).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it("定不下来时把原因交回给模型，别静悄悄当成功了", async () => {
    const { ctx } = makeCtx();
    ctx.scheduleReminder = async () => {
      throw new Error("这个时间已经过去了：2020-01-01T09:00:00+08:00");
    };
    const out = await openOf(ctx)({
      title: "补一场",
      content: "想跟你说件事",
      at: "2020-01-01T09:00:00+08:00",
    });
    expect(out).toContain("已经过去了");
  });
});
