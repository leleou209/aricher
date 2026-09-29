import { describe, expect, it } from "vitest";
import {
  EXP_MAX,
  experiencePrompt,
  isDuplicate,
  parseExperience,
} from "../src/agent/experience";

describe("parseExperience", () => {
  it("只留第一人称的规律，按行拆开", () => {
    const out = parseExperience(
      "- 他问技术问题时，先给能跑起来的做法，再讲原理",
    );
    expect(out).toEqual(["他问技术问题时，先给能跑起来的做法，再讲原理"]);
  });

  it("去掉各种列表符号", () => {
    expect(parseExperience("1. 给选项别问假问题")).toEqual([
      "给选项别问假问题",
    ]);
    expect(parseExperience("第二条：先确认再动手")).toEqual(["先确认再动手"]);
    expect(parseExperience("• 别急着下结论")).toEqual(["别急着下结论"]);
  });

  it("SKIP 全家桶都不产出", () => {
    expect(parseExperience("SKIP")).toEqual([]);
    expect(parseExperience("没有学到什么，跳过")).toEqual([]);
    expect(parseExperience("[SKIP]")).toEqual([]);
  });

  it("太短或太长都丢弃", () => {
    expect(parseExperience("- 嗨")).toEqual([]);
    expect(parseExperience("- 好")).toEqual([]);
    expect(parseExperience(`- ${"长".repeat(EXP_MAX + 1)}`)).toEqual([]);
  });

  it("去重相同行", () => {
    const out = parseExperience(
      "先给能跑的做法再讲原理\n先给能跑的做法再讲原理",
    );
    expect(out).toEqual(["先给能跑的做法再讲原理"]);
  });
});

describe("isDuplicate", () => {
  it("相同语义判为重复", () => {
    expect(
      isDuplicate("他问技术问题时先给做法再讲原理", [
        "问技术问题时，先给能跑的做法再讲原理",
      ]),
    ).toBe(true);
  });

  it("不同语义判为不重复", () => {
    expect(
      isDuplicate("他问技术问题时先给做法", ["他情绪不好时先陪他说说话"]),
    ).toBe(false);
  });

  it("太短无法判断时视为重复（宁可不存）", () => {
    expect(isDuplicate("hi", ["随便一条"])).toBe(true);
  });
});

describe("experiencePrompt", () => {
  it("空经验时也给出提示", () => {
    const p = experiencePrompt([]);
    expect(p).toContain("我以后该怎么做");
    expect(p).not.toContain("undefined");
  });
});
