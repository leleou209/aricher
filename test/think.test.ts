/**
 * 「她正在想什么」（think.ts）测试。
 *
 * 这一段是替「卡了」这个观感兜底的：它该出声的时候不出声，来客那边就只剩一个空气泡；
 * 它不该出声的时候乱出声，就会把维护模型上的钱和本该属于正文的位置一起浪费掉。
 * 所以两边都要钉死：
 *   - 快答不出声（三秒内答完的不该闪一下「她正在想」）；
 *   - 想得久就一句一句往外说（这是它存在的理由）；
 *   - 她已经在说话、手上也没在忙 —— 不再翻（外面看得见正文）；
 *   - 说到一半去画图 —— 还得翻（那一段是真空白）；
 *   - 一轮有上限，收尾之后立刻住手，上一轮的尾巴不许落到新一轮头上。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EVERY,
  FIRST_AFTER,
  MOST_LINES,
  MOST_TICKS,
  Thinker,
  cleanLine,
} from "../src/agent/think";

/** 一个只会照着稿子念的维护模型，加上一个把说过的话记下来的广播口 */
function stage(lines: string[] = ["在琢磨怎么答你这句话"]) {
  const said: string[] = [];
  const asked: string[] = [];
  let i = 0;
  const t = new Thinker({
    ask: (_system, user) => {
      asked.push(user);
      const line = lines[Math.min(i, lines.length - 1)];
      i += 1;
      return Promise.resolve(line);
    },
    emit: (turn, line) => said.push(`${turn}:${line}`),
  });
  return { t, said, asked };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("cleanLine", () => {
  it("只取第一行，引号和编号都脱掉", () => {
    expect(cleanLine("「在翻记忆对一下上次那件事」")).toBe(
      "在翻记忆对一下上次那件事",
    );
    expect(cleanLine("- 正在查资料\n后面还有一段解释")).toBe("正在查资料");
    expect(cleanLine("1. 在想要不要直接说结论")).toBe("在想要不要直接说结论");
    expect(cleanLine("   \n\n 正在读他那段话  \n")).toBe("正在读他那段话");
  });

  it("没有输出就是空，不硬凑一句", () => {
    expect(cleanLine("")).toBe("");
    expect(cleanLine("\n  \n")).toBe("");
  });

  it("太长就截住：这一行是摆着看的，不是让她写小作文的", () => {
    const long = cleanLine("正".repeat(80));
    expect(long.length).toBe(41);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("Thinker", () => {
  it("三秒内就答完的，一个字都不往外说", async () => {
    const { t, said, asked } = stage();
    const turn = t.begin("你好");
    const ran = t.run(turn);

    await vi.advanceTimersByTimeAsync(FIRST_AFTER - 100);
    expect(asked).toEqual([]);

    t.end();
    await vi.advanceTimersByTimeAsync(EVERY);
    await ran;
    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });

  it("一直不出声就一句一句往外说，每句带这一轮的号", async () => {
    const { t, said, asked } = stage([
      "在翻记忆",
      "在想要不要直说",
      "快想好了",
    ]);
    const turn = t.begin("帮我查一下那件事");
    const ran = t.run(turn);

    await vi.advanceTimersByTimeAsync(FIRST_AFTER + 10);
    expect(said).toEqual([`${turn}:在翻记忆`]);

    await vi.advanceTimersByTimeAsync(EVERY + 10);
    await vi.advanceTimersByTimeAsync(EVERY + 10);
    expect(said).toEqual([
      `${turn}:在翻记忆`,
      `${turn}:在想要不要直说`,
      `${turn}:快想好了`,
    ]);

    // 喂给维护模型的材料里得有他说过的那句话，否则它只能凭空编
    expect(asked[0]).toContain("帮我查一下那件事");

    t.end();
    await ran;
  });

  it("她已经在说话、手上也没在忙 —— 就不再花那一次调用", async () => {
    const { t, asked } = stage();
    const turn = t.begin("在吗");
    const ran = t.run(turn);

    t.observe({ type: "reasoning-delta", text: "先看看他问的是什么" });
    t.observe({ type: "text-delta", text: "在的" });

    await vi.advanceTimersByTimeAsync(FIRST_AFTER + 10);
    expect(asked).toEqual([]);

    t.end();
    await ran;
  });

  it("说到一半去画图 —— 那一段是真空白，还得接着说", async () => {
    const { t, asked } = stage();
    const turn = t.begin("给我画一张");
    const ran = t.run(turn);

    t.observe({ type: "text-delta", text: "好，我画一张" });
    t.observe({ type: "tool-call", toolName: "draw" });

    await vi.advanceTimersByTimeAsync(FIRST_AFTER + 10);
    expect(asked.length).toBe(1);
    // 材料里要说清她手上正忙什么，模型才不至于写成「我在回忆」
    expect(asked[0]).toContain("…draw");

    // 图回来了、她接着说话：外面看得见正文了，下一拍就不翻
    t.observe({ type: "tool-result", toolName: "draw" });
    await vi.advanceTimersByTimeAsync(EVERY + 10);
    expect(asked.length).toBe(1);

    t.end();
    await ran;
  });

  it("一轮翻不了几句，到数就住手", async () => {
    const { t, said } = stage();
    const turn = t.begin("慢慢想");
    const ran = t.run(turn);

    await vi.advanceTimersByTimeAsync(FIRST_AFTER + 10);
    for (let i = 0; i < MOST_TICKS; i++) {
      await vi.advanceTimersByTimeAsync(EVERY + 10);
    }
    expect(said.length).toBe(MOST_LINES);

    t.end();
    await ran;
  });

  it("新一轮开始之后，上一轮那个还在睡的节拍器不许再出声", async () => {
    const { t, said } = stage();
    const first = t.begin("第一句");
    const firstRan = t.run(first);
    const second = t.begin("第二句");
    const secondRan = t.run(second);

    await vi.advanceTimersByTimeAsync(FIRST_AFTER + 10);
    expect(said.length).toBe(1);
    expect(said[0].startsWith(`${second}:`)).toBe(true);

    t.end();
    await vi.advanceTimersByTimeAsync(EVERY);
    await Promise.all([firstRan, secondRan]);
  });

  it("翻不出来不硬推：这一句宁可不摆，也不能摆一句编的", async () => {
    const said: string[] = [];
    const t = new Thinker({
      ask: () => Promise.resolve(""),
      emit: (turn, line) => said.push(`${turn}:${line}`),
    });
    const turn = t.begin("你在吗");
    const ran = t.run(turn);

    await vi.advanceTimersByTimeAsync(FIRST_AFTER + 10);
    expect(said).toEqual([]);

    // 连着两次都不行就这一轮算了，不再往下空转
    await vi.advanceTimersByTimeAsync(EVERY * (MOST_TICKS + 2));
    expect(said).toEqual([]);

    t.end();
    await ran;
  });
});
