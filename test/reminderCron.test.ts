/**
 * 重复提醒的时区换算测试（shanghaiEveryToCron）。
 *
 * SDK 的 schedule 不收时区，cron 一律按 UTC 解释——说明里写「0 9 * * * 是
 * 每天九点」，真响起来是北京时间 17 点。换算函数把北京时间的友好排期
 * 转成等价 UTC cron：每天平移 8 小时；每周平移跨日时星期字段要环回。
 * 运行: npx vitest run
 */

import { describe, expect, it } from "vitest";
import { shanghaiEveryToCron } from "../src/agent/reminderStore";

describe("shanghaiEveryToCron：北京时间排期 → 等价 UTC cron", () => {
  it("每天 09:00 → UTC 01:00（平移 8 小时）", () => {
    expect(shanghaiEveryToCron("每天 09:00")).toBe("0 1 * * *");
  });

  it("每天 07:30 → 跨日：UTC 前一天 23:30", () => {
    expect(shanghaiEveryToCron("每天 07:30")).toBe("30 23 * * *");
  });

  it("没有空格的「每天09:00」也认", () => {
    expect(shanghaiEveryToCron("每天09:00")).toBe("0 1 * * *");
  });

  it("每周三 21:30 → UTC 周三 13:30（同日）", () => {
    expect(shanghaiEveryToCron("每周三 21:30")).toBe("30 13 * * 3");
  });

  it("每周一 05:00 → 跨日：UTC 周日 21:00（星期环回）", () => {
    expect(shanghaiEveryToCron("每周一 05:00")).toBe("0 21 * * 0");
  });

  it("每周日 00:15 → 跨日：UTC 周六 16:15（周日环回到周六）", () => {
    expect(shanghaiEveryToCron("每周日 00:15")).toBe("15 16 * * 6");
  });

  it("cron 表达式原样透传（进阶用法，UTC 语义自担）", () => {
    expect(shanghaiEveryToCron("0 9 * * *")).toBe("0 9 * * *");
    expect(shanghaiEveryToCron("*/10 * * * *")).toBe("*/10 * * * *");
  });
});
