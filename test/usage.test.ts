/**
 * 资源自计量测试（src/agent/usage.ts）。
 *
 * 面板上「AI 算力 / Vectorize」两栏的数字全从这里出，所以要钉死三件事：
 *   1. 估算口径别飘 —— token 估、FLUX tile 数都有官方单价可对。
 *   2. 跨天/跨月清零 —— 昨天的账不能压在今天头上。
 *   3. 驱逐重启接账是「加」不是「换」 —— 换掉会把唤醒后、接账前那几笔抹掉。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  UsageCounter,
  estimateTokens,
  fluxNeurons,
  utcDay,
  utcMonth,
  NEURONS_CAP,
  VEC_QUERY_CAP,
  VEC_STORE_CAP,
  EMBED_DIMS,
  NEURONS_PER_TOKEN,
  type UsageSnapshot,
} from "../src/agent/usage";

/** 固定基准：2026-09-24T06:00:00Z（UTC 日 = 2026-09-24，月 = 2026-09） */
const T = Date.UTC(2026, 8, 24, 6, 0, 0);
const DAY_MS = 86_400_000;

function freezeNow(now: number) {
  vi.spyOn(Date, "now").mockReturnValue(now);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function snapOf(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    day: utcDay(T),
    neurons: 0,
    embeds: 0,
    images: 0,
    month: utcMonth(T),
    vecQueriedDims: 0,
    vecStoredDims: 0,
    ...over,
  };
}

describe("estimateTokens", () => {
  it("中日韩一个字算一个 token", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("こんにちは")).toBe(5);
  });

  it("其余四个字符一个，向上取整", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("中英混排各算各的", () => {
    // 2 个汉字 + 「 ab」三个非 CJK → 2 + ceil(3/4) = 3
    expect(estimateTokens("你好 ab")).toBe(3);
  });

  it("空串是零", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("fluxNeurons", () => {
  it("512x512 是一个输出 tile 加提示词那侧", () => {
    expect(fluxNeurons(512, 512)).toBeCloseTo(26.05 + 5.37, 2);
  });

  it("1024x1024 是四个 tile", () => {
    expect(fluxNeurons(1024, 1024)).toBeCloseTo(4 * 26.05 + 5.37, 2);
  });

  it("不满一格也占一格", () => {
    expect(fluxNeurons(600, 600)).toBeCloseTo(4 * 26.05 + 5.37, 2);
  });
});

describe("UsageCounter 记账", () => {
  it("新开的账本全是零，但上限和日期齐全", () => {
    freezeNow(T);
    const c = new UsageCounter();
    const rep = c.report();
    expect(rep.day).toBe("2026-09-24");
    expect(rep.month).toBe("2026-09");
    expect(rep.neurons).toBe(0);
    expect(rep.neuronsCap).toBe(NEURONS_CAP);
    expect(rep.vecQueryCap).toBe(VEC_QUERY_CAP);
    expect(rep.vecStoreCap).toBe(VEC_STORE_CAP);
  });

  it("一次嵌入 = 估算 token × 单价，次数也记", () => {
    freezeNow(T);
    const c = new UsageCounter();
    c.noteEmbed("你好世界"); // 4 token
    const rep = c.report();
    expect(rep.embeds).toBe(1);
    expect(rep.neurons).toBe(Math.round(4 * NEURONS_PER_TOKEN));
  });

  it("一张 FLUX 图按 tile 计 neurons 并计数", () => {
    freezeNow(T);
    const c = new UsageCounter();
    c.noteFluxImage(1024, 1024);
    const rep = c.report();
    expect(rep.images).toBe(1);
    expect(rep.neurons).toBe(Math.round(4 * 26.05 + 5.37));
  });

  it("Vectorize 查询按 topK × 维度累计", () => {
    freezeNow(T);
    const c = new UsageCounter();
    c.noteVecQuery(5);
    expect(c.report().vecQueriedDims).toBe(5 * EMBED_DIMS);
  });

  it("存量加减都有下限：删过头不会变成负数", () => {
    freezeNow(T);
    const c = new UsageCounter();
    c.noteVecUpsert();
    expect(c.report().vecStoredDims).toBe(EMBED_DIMS);
    c.noteVecDelete();
    c.noteVecDelete();
    expect(c.report().vecStoredDims).toBe(0);
  });
});

describe("UsageCounter 滚动", () => {
  it("跨天：日计数清零，月计数留下", () => {
    freezeNow(T);
    const c = new UsageCounter();
    c.noteEmbed("你好世界");
    c.noteVecQuery(2);
    freezeNow(T + DAY_MS); // 2026-09-25，还在同一个月
    const rep = c.report();
    expect(rep.day).toBe("2026-09-25");
    expect(rep.neurons).toBe(0);
    expect(rep.embeds).toBe(0);
    expect(rep.vecQueriedDims).toBe(2 * EMBED_DIMS);
  });

  it("跨月：月计数也清零", () => {
    freezeNow(T);
    const c = new UsageCounter();
    c.noteVecQuery(2);
    freezeNow(Date.UTC(2026, 9, 2)); // 10 月
    const rep = c.report();
    expect(rep.month).toBe("2026-10");
    expect(rep.vecQueriedDims).toBe(0);
  });
});

describe("UsageCounter 接账（驱逐重启）", () => {
  it("接账是累加：state 里的旧总数 + 开机后的新增", () => {
    freezeNow(T);
    const c = new UsageCounter();
    c.noteEmbed("你好世界"); // 开机后先来了一笔：4 token ≈ 4.3
    c.hydrate(
      snapOf({
        neurons: 10,
        embeds: 2,
        images: 1,
        vecQueriedDims: 2048,
        vecStoredDims: 1024,
      }),
    );
    const rep = c.report();
    expect(rep.embeds).toBe(3);
    expect(rep.images).toBe(1);
    expect(rep.neurons).toBe(Math.round(4 * NEURONS_PER_TOKEN + 10));
    expect(rep.vecQueriedDims).toBe(2048);
    expect(rep.vecStoredDims).toBe(1024);
  });

  it("只接一次：第二次 hydrate 不会把账翻倍", () => {
    freezeNow(T);
    const c = new UsageCounter();
    const saved = snapOf({ neurons: 10, embeds: 2 });
    c.hydrate(saved);
    c.hydrate(saved);
    expect(c.report().embeds).toBe(2);
  });

  it("昨天的旧账作废：跨天的日计数不接", () => {
    freezeNow(T);
    const c = new UsageCounter();
    c.hydrate(
      snapOf({ day: utcDay(T - DAY_MS), neurons: 999, embeds: 9, images: 5 }),
    );
    const rep = c.report();
    expect(rep.neurons).toBe(0);
    expect(rep.embeds).toBe(0);
    expect(rep.images).toBe(0);
  });

  it("上月的旧月账作废，但同月的日计数照接", () => {
    freezeNow(T);
    const c = new UsageCounter();
    c.hydrate(
      snapOf({
        month: "2026-08",
        neurons: 10,
        embeds: 1,
        vecQueriedDims: 999_999,
      }),
    );
    const rep = c.report();
    expect(rep.embeds).toBe(1);
    expect(rep.vecQueriedDims).toBe(0);
  });

  it("空账（老 state 没这个字段）不炸", () => {
    freezeNow(T);
    const c = new UsageCounter();
    c.hydrate(undefined);
    c.hydrate(null);
    expect(c.report().neurons).toBe(0);
  });
});

describe("UsageCounter 脏检查（省写额度）", () => {
  it("没动过就不脏；记一笔就脏；写回后又不脏", () => {
    freezeNow(T);
    const c = new UsageCounter();
    expect(c.dirty()).toBe(false);
    c.noteEmbed("你好");
    expect(c.dirty()).toBe(true);
    c.markFlushed();
    expect(c.dirty()).toBe(false);
  });

  it("接完账当场算干净 —— 唤醒不等于有新消耗", () => {
    freezeNow(T);
    const c = new UsageCounter();
    c.hydrate(snapOf({ neurons: 10 }));
    expect(c.dirty()).toBe(false);
  });

  it("跨天清零本身算「动了」：脏一次，把新日期写回去", () => {
    freezeNow(T);
    const c = new UsageCounter();
    c.markFlushed();
    freezeNow(T + DAY_MS);
    expect(c.dirty()).toBe(true);
    c.markFlushed();
    expect(c.dirty()).toBe(false);
  });
});
