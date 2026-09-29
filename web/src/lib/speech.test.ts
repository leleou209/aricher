import { describe, expect, it } from "vitest";
import { stripForSpeech } from "./speech";

describe("stripForSpeech（把 Markdown 剥成能念的话）", () => {
  it("去掉加粗和斜体的星号：不能让它念出「星号星号」", () => {
    expect(stripForSpeech("我**不建议**这么做，*真的*。")).toBe(
      "我不建议这么做，真的。",
    );
  });

  it("代码块整段跳过，但要留一句话告诉听的人这里跳过了", () => {
    const out = stripForSpeech("先这样写：\n```ts\nconst a = 1;\n```\n就好了");
    expect(out).toContain("这里有一段代码");
    expect(out).not.toContain("const");
  });

  it("行内代码只留内容，反引号不念", () => {
    expect(stripForSpeech("用 `memory` 工具记一下")).toBe(
      "用 memory 工具记一下",
    );
  });

  it("链接只念文字，不念网址", () => {
    expect(stripForSpeech("见[这篇](https://example.com/a?b=1)")).toBe(
      "见这篇",
    );
  });

  it("标题、列表、引用的符号都去掉，换行变成逗号（念出来才像人说话）", () => {
    expect(stripForSpeech("## 我的判断\n- 第一点\n- 第二点\n> 引一句")).toBe(
      "我的判断，第一点，第二点，引一句",
    );
  });

  it("表格整行跳过：念表格等于念乱码", () => {
    const out = stripForSpeech(
      "对比一下：\n| A | B |\n| --- | --- |\n| 1 | 2 |\n就这些",
    );
    expect(out).not.toContain("|");
    expect(out).toContain("就这些");
  });

  it("表情不念", () => {
    expect(stripForSpeech("记住了 👍🎉")).toBe("记住了");
  });

  it("零宽字符、BOM、私用区字符摘掉：合成器碰上它们会发出「滴」的电子音", () => {
    expect(stripForSpeech("记住了\u200B\u200D\uFEFF\uE000")).toBe("记住了");
  });

  it("只做最小切除：正常正文一个字都不改", () => {
    // % 和 ¥ 这种「白名单一收紧就会被吃掉」的符号，正是不能动的那类 ——
    // 为了消一个噪音而改写人说的话，代价比噪音本身大得多
    expect(stripForSpeech("报价 30%，约 ¥25，或者 3~5 天（可议）。")).toBe(
      "报价 30%，约 ¥25，或者 3~5 天（可议）。",
    );
  });

  it("箭头、方块这类装饰符号摘掉，但不碰旁边的字", () => {
    expect(stripForSpeech("先这样→再那样，最后●收尾")).toBe(
      "先这样 再那样，最后 收尾",
    );
  });

  it("空输入返回空串（调用方靠这个决定要不要出声）", () => {
    expect(stripForSpeech("   ")).toBe("");
  });
});
