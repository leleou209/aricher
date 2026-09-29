/**
 * 上下文压缩的边界测试。
 *
 * 这块逻辑一旦错，错法是「悄悄少了一段对话」——模型不会报错，用户也看不出来，
 * 只是某天发现她不记得三天前说过的事。所以这里把边界情形都钉死。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  COMPACT_TRIGGER,
  KEEP_RECENT,
  planContext,
} from "../src/agent/context";

/** 造一串消息：u/a 交替，带稳定 id */
function thread(roles: string[]): UIMessage[] {
  return roles.map((role, i) => ({
    id: "m" + i,
    role: role === "u" ? "user" : "assistant",
    parts: [{ type: "text", text: "第" + i + "条" }],
  })) as UIMessage[];
}

describe("planContext", () => {
  it("短对话一条不压，全部原样发出", () => {
    const msgs = thread(["u", "a", "u", "a"]);
    const plan = planContext(msgs, "");
    expect(plan.compacted).toEqual([]);
    expect(plan.tail).toEqual(msgs);
  });

  it("刚过保留线、攒不够触发量时不压", () => {
    // 保留 16 条 + 只多出 3 条 → 不够 COMPACT_TRIGGER，白压一次不划算
    const msgs = thread(
      Array.from({ length: KEEP_RECENT + 3 }, (_, i) => (i % 2 ? "a" : "u")),
    );
    const plan = planContext(msgs, "");
    expect(plan.compacted).toEqual([]);
    expect(plan.tail.length).toBe(msgs.length);
  });

  it("够长了就压掉老的一段，并把切点落在用户发言前", () => {
    const msgs = thread(
      Array.from({ length: KEEP_RECENT + COMPACT_TRIGGER + 6 }, (_, i) =>
        i % 2 ? "a" : "u",
      ),
    );
    const plan = planContext(msgs, "");
    expect(plan.compacted.length).toBeGreaterThanOrEqual(COMPACT_TRIGGER);
    expect(plan.tail[0].role).toBe("user");
    // 压掉的 + 留下的 = 全部，一条都不能凭空消失
    expect(plan.compacted.length + plan.tail.length).toBe(msgs.length);
    expect(plan.upto).toBe(plan.compacted[plan.compacted.length - 1].id);
  });

  it("已压过的部分不再重发，只发它之后的", () => {
    const msgs = thread(
      Array.from({ length: 40 }, (_, i) => (i % 2 ? "a" : "u")),
    );
    const first = planContext(msgs, "");
    const second = planContext(msgs, first.upto);
    expect(second.compacted).toEqual([]);
    expect(second.tail[0].id).toBe(first.tail[0].id);
    expect(second.tail.length).toBeLessThan(msgs.length);
  });

  it("摘要记的 id 找不到时退回从头算，不静默丢消息", () => {
    const msgs = thread(
      Array.from({ length: 30 }, (_, i) => (i % 2 ? "a" : "u")),
    );
    const plan = planContext(msgs, "早就被清掉的id");
    expect(plan.compacted.length + plan.tail.length).toBe(msgs.length);
  });

  it("尾巴全是工具往返、切不出干净边界时这轮不压", () => {
    // 前 20 条正常，后面 20 条全是 assistant（模拟工具往返），切点找不到用户发言
    const msgs = thread([
      ...Array.from({ length: 20 }, (_, i) => (i % 2 ? "a" : "u")),
      ...Array(20).fill("a"),
    ]);
    const plan = planContext(msgs, "");
    expect(plan.compacted).toEqual([]);
    expect(plan.tail.length).toBe(msgs.length);
  });

  it("无论怎么压，都不留空上下文给模型", () => {
    const msgs = thread(
      Array.from({ length: 50 }, (_, i) => (i % 2 ? "a" : "u")),
    );
    let upto = "";
    for (let round = 0; round < 5; round++) {
      const plan = planContext(msgs, upto);
      expect(plan.tail.length).toBeGreaterThanOrEqual(2);
      upto = plan.upto;
    }
  });
});
