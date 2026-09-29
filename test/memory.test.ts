/**
 * 记忆检索打分测试。
 *
 * 直接 import 生产实现（src/agent/memory.ts），不再复制一份打分逻辑 ——
 * 旧版本复制的副本里 `Math.min(daysOld, 1)` 与生产的 `Math.min(daysOld, 365)`
 * 不一致，测试通过但代码是错的。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import {
  insertMemory,
  listPublicMemories,
  memoryHitLines,
  memoryKeywords,
  needsReview,
  reviewRef,
  scoreMemory,
  searchMemories,
  setSensitivity,
  setTagAccess,
  setVisibility,
  tagStats,
  textOverlap,
  touchWeights,
} from "../src/agent/memory";
import { runHeartbeat } from "../src/agent/runtime";
import type { MemEntry, SqlTag } from "../src/agent/state";

const today = new Date().toISOString().slice(0, 10);
const now = Date.now();
const fresh = {
  learned: today + "T00:00:00.000Z",
  supersededBy: "",
  volatility: "stable" as const,
  verified: "",
  validAt: today + "T00:00:00.000Z",
  invalidAt: "",
  conflictsWith: [] as string[],
  // 默认 private：能不能给来客看该是人主动点头的事，测试里也照这个默认走
  visibility: "private" as const,
  // 没收回过：hold 只听「公开 / 收回」按钮，写入路径碰不到它
  hold: false,
  // 老三样条目：没有标题、不指向图
  title: "",
  fileKey: "",
  // 也不属于任何一场对话：这几条是长期记忆，不是某次聊天的回想
  sessionId: "",
  sentiment: "",
  // 量级：没标过的按「一般」算 —— 和存量数据的默认同一个规矩
  sensitivity: "normal" as const,
  score: 0,
};

const seeds: MemEntry[] = [
  {
    id: "m001",
    date: today,
    ...fresh,
    type: "insight",
    tags: ["insight", "communication"],
    weight: 0.6,
    shelf: "people",
    person: "",
    content: "管理员习惯深夜工作，沟通简洁直接",
    accessed: 0,
  },
  {
    id: "m006",
    date: today,
    ...fresh,
    type: "fact",
    tags: ["fact", "project"],
    weight: 0.8,
    shelf: "projects",
    person: "",
    content: "示例项目用于练习规划，属于长期项目",
    accessed: 0,
  },
  {
    id: "m009",
    date: today,
    ...fresh,
    type: "insight",
    tags: ["insight", "health"],
    weight: 0.4,
    shelf: "patterns",
    person: "",
    content: "容易在项目兴奋期过度投入，需要提醒休息",
    accessed: 0,
  },
  // learned 比 date 晚很多：三年前的事今天才听说，衰减该按「学到」算，不该按「发生」算
  {
    id: "m012",
    date: "2020-01-01",
    ...fresh,
    learned: today + "T00:00:00.000Z",
    type: "insight",
    tags: ["insight", "preference"],
    weight: 0.5,
    shelf: "patterns",
    person: "",
    content: "管理员对AI的态度是实用主义，关注实际落地效果",
    accessed: 0,
  },
];

function rank(query: string): MemEntry[] {
  const kws = memoryKeywords(query);
  return seeds
    .map((entry) => ({ entry, score: scoreMemory(entry, kws, now) }))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.entry);
}

describe("memoryKeywords", () => {
  it("按中英文标点和空白切词，丢弃单字", () => {
    expect(memoryKeywords("深夜，工作 AI")).toEqual(["深夜", "工作", "ai"]);
  });

  it("单字查询切不出关键词", () => {
    expect(memoryKeywords("好")).toEqual([]);
  });

  // 这一条是这次改动的全部理由：整句中文从前是一个词，要求逐字出现才算命中，
  // 于是「正常对话靠关键词检索」在中文里其实是空转的
  it("整句中文切成二字组，不必等向量层", () => {
    const kws = memoryKeywords("他习惯深夜工作");
    expect(kws).toContain("深夜");
    expect(kws).toContain("工作");
    expect(kws).toContain("习惯");
  });

  it("中英夹在一起时两边都留（「AI模型」）", () => {
    expect(memoryKeywords("AI模型")).toEqual(["ai", "模型"]);
  });

  it("重复的说法只算一次，不让同一个词把分数顶上去", () => {
    expect(memoryKeywords("喜欢喝茶，喜欢喝茶")).toEqual([
      "喜欢",
      "欢喝",
      "喝茶",
    ]);
  });
});

describe("scoreMemory", () => {
  it("搜索'深夜 工作'命中 m001", () => {
    expect(rank("深夜 工作")[0].id).toBe("m001");
  });

  it("搜索'示例'命中 m006", () => {
    expect(rank("示例")[0].id).toBe("m006");
  });

  it("整句问话也算关键词命中：从前这种查询切出来是一个长词，谁都命中不上", () => {
    expect(rank("他习惯深夜工作吗")[0].id).toBe("m001");
  });

  it("命中 tag 的得分高于只命中正文", () => {
    const kws = ["communication"];
    const m001 = scoreMemory(seeds[0], kws, now);
    const m006 = scoreMemory(seeds[1], kws, now);
    expect(m001).toBeGreaterThan(m006);
  });

  it("同一查询下，早就学到的记忆得分被衰减", () => {
    const kws = memoryKeywords("管理员");
    const patch = { weight: 0.5, content: "管理员", tags: [] as string[] };
    const old = {
      ...seeds[0],
      ...patch,
      date: "2020-01-01",
      learned: "2020-01-01T00:00:00.000Z",
    };
    const recent = {
      ...seeds[0],
      ...patch,
      date: today,
      learned: new Date(now).toISOString(),
    };
    expect(scoreMemory(old, kws, now)).toBeLessThan(
      scoreMemory(recent, kws, now),
    );
  });

  it("衰减按「学到」算，不按「发生」算：三年前的事今天才听说，不该被当成老记忆", () => {
    const kws = memoryKeywords("管理员");
    const patch = { weight: 0.5, content: "管理员", tags: [] as string[] };
    const justLearned = {
      ...seeds[0],
      ...patch,
      date: "2020-01-01",
      learned: new Date(now).toISOString(),
    };
    const longKnown = {
      ...seeds[0],
      ...patch,
      date: today,
      learned: "2020-01-01T00:00:00.000Z",
    };
    expect(scoreMemory(justLearned, kws, now)).toBeGreaterThan(
      scoreMemory(longKnown, kws, now),
    );
  });
});

/**
 * 写入次数是配额项：这里出过一次真事故 —— 一次检索把扫描到的每一行都 UPDATE，
 * 攒够「写入行数」之后整张记忆表连读都失败，记忆功能全瘫。
 * 所以这个测试盯的是「不该写的，一行都别写」。
 */
describe("touchWeights（写入次数）", () => {
  const fakeSql = () => {
    const writes: string[] = [];
    const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
      writes.push(strings.join("?") + " " + JSON.stringify(values));
      return [] as never;
    };
    return { sql: tag as unknown as SqlTag, writes };
  };
  const entry = (id: string, weight: number): MemEntry => ({
    ...seeds[0],
    id,
    weight,
  });

  it("未命中的一行都不写（这是配额事故的根源）", () => {
    const { sql, writes } = fakeSql();
    touchWeights(sql, new Set(["m001"]), [
      entry("m001", 0.5),
      entry("m002", 0.5),
      entry("m003", 0.5),
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("m001");
  });

  it("命中且没到顶 → 权重 +0.05", () => {
    const { sql, writes } = fakeSql();
    touchWeights(sql, new Set(["m001"]), [entry("m001", 0.6)]);
    expect(writes[0]).toContain("0.65");
  });

  it("已经到顶的不再写（到顶的记忆往往最常命中，写它纯属白花配额）", () => {
    const { sql, writes } = fakeSql();
    touchWeights(sql, new Set(["m001"]), [entry("m001", 1)]);
    expect(writes).toHaveLength(0);
  });

  it("权重缺失时按 0.5 起算", () => {
    const { sql, writes } = fakeSql();
    touchWeights(sql, new Set(["m001"]), [{ ...entry("m001", 0), weight: 0 }]);
    expect(writes[0]).toContain("0.55");
  });

  it("同一次 UPDATE 顺手记下 last_accessed_at —— 裁剪认时刻不认次数", () => {
    const { sql, writes } = fakeSql();
    touchWeights(sql, new Set(["m001"]), [entry("m001", 0.5)]);
    expect(writes[0]).toContain("last_accessed_at");
  });
});

describe("needsReview", () => {
  const days = (n: number) => new Date(now - n * 86400000).toISOString();
  const entry = (patch: Partial<MemEntry>): MemEntry => ({
    ...seeds[0],
    ...patch,
  });

  it("稳定记忆永远不用复核", () => {
    expect(
      needsReview(
        entry({ volatility: "stable", learned: "2020-01-01T00:00:00.000Z" }),
        now,
      ),
    ).toBe(false);
  });

  it("会变 + 刚学到 → 还不用复核", () => {
    expect(
      needsReview(entry({ volatility: "volatile", learned: days(3) }), now),
    ).toBe(false);
  });

  it("会变 + 学到 40 天没确认过 → 该复核", () => {
    expect(
      needsReview(entry({ volatility: "volatile", learned: days(40) }), now),
    ).toBe(true);
  });

  it("确认过之后就不该再催：学到很旧，但 5 天前刚核对过", () => {
    expect(
      needsReview(
        entry({
          volatility: "volatile",
          learned: days(300),
          verified: days(5),
        }),
        now,
      ),
    ).toBe(false);
  });

  it("确认过但确认本身也旧了 → 重新该复核", () => {
    expect(
      needsReview(
        entry({
          volatility: "volatile",
          learned: days(300),
          verified: days(90),
        }),
        now,
      ),
    ).toBe(true);
  });

  it("已作废的不进复核清单（它已经不算数了，催确认没意义）", () => {
    expect(
      needsReview(
        entry({
          volatility: "volatile",
          learned: days(300),
          supersededBy: "m999",
        }),
        now,
      ),
    ).toBe(false);
  });

  it("时间不明时会变的记忆算该复核（宁可多问一句，也不当实情讲）", () => {
    expect(
      needsReview(
        entry({ volatility: "volatile", learned: "", date: "" }),
        now,
      ),
    ).toBe(true);
  });
});

describe("reviewRef", () => {
  it("确认过就以确认为准，没确认过退到学到的时候", () => {
    expect(
      reviewRef({
        verified: "2026-01-01T00:00:00.000Z",
        learned: "2025-01-01T00:00:00.000Z",
        date: "2024-01-01",
      }),
    ).toBe("2026-01-01T00:00:00.000Z");
    expect(
      reviewRef({
        verified: "",
        learned: "2025-01-01T00:00:00.000Z",
        date: "2024-01-01",
      }),
    ).toBe("2025-01-01T00:00:00.000Z");
  });
});

describe("memoryHitLines（注入系统提示词的那几行）", () => {
  const days = (n: number) => new Date(now - n * 86400000).toISOString();
  const entry = (patch: Partial<MemEntry>): MemEntry => ({
    ...seeds[0],
    ...patch,
  });

  it("稳定的记忆不挂警告，只标书架和学到多久了", () => {
    const [line] = memoryHitLines(
      [entry({ volatility: "stable", learned: days(300) })],
      now,
    );
    expect(line).toContain("[people · 学到");
    expect(line).not.toContain("⚠️");
  });

  it("会变又久没核对的挂警告，并说清是多久没核对", () => {
    const [line] = memoryHitLines(
      [entry({ volatility: "volatile", learned: days(100) })],
      now,
    );
    expect(line).toContain("⚠️这条说的是现状");
    expect(line).toContain("3 个月前没核对过");
  });

  it("刚确认过的会变记忆不挂警告", () => {
    const hit = entry({
      volatility: "volatile",
      learned: days(300),
      verified: days(2),
    });
    expect(memoryHitLines([hit], now)[0]).not.toContain("⚠️");
  });

  it("归属人物的记忆把人也带出来", () => {
    const [line] = memoryHitLines(
      [entry({ person: "李", learned: days(1) })],
      now,
    );
    expect(line).toContain("· 李]");
  });
});

/**
 * 冲突候选的第一把尺子。挑错候选只是多问一句，漏掉却是两条矛盾的话
 * 同时躺在记忆库里 —— 所以阈值宁可松，判定「算不算同一件事」交给模型。
 */
describe("textOverlap（措辞像不像）", () => {
  it("同一句话多了个细节 → 很高", () => {
    expect(
      textOverlap("管理员在一家小公司工作", "管理员在一家小公司工作，做后端"),
    ).toBeGreaterThan(0.75);
  });

  it("一句话只换了个词 → 高", () => {
    expect(textOverlap("管理员喜欢喝咖啡", "管理员喜欢喝茶")).toBeGreaterThan(
      0.6,
    );
  });

  it("说的是两件不相干的事 → 低", () => {
    expect(textOverlap("管理员在一家小公司工作", "示例项目是长期项目")).toBeLessThan(
      0.2,
    );
  });

  it("标点和空格不影响判断", () => {
    expect(
      textOverlap("管理员在小公司工作。", "管理员在 小公司 工作"),
    ).toBeGreaterThan(0.85);
  });

  it("太短的句子比不出什么（没有二元组就不乱猜）", () => {
    expect(textOverlap("好", "好")).toBe(0);
  });
});

describe("searchMemories 的来客受限读（归属键 owner_key）", () => {
  const row = (over: Partial<Record<string, string | number>>) => ({
    id: "x",
    date: today,
    type: "fact",
    tags: "fact",
    weight: 0.5,
    shelf: "people",
    person: "",
    visibility: "private",
    content: "他说他常去爬山",
    accessed: 0,
    learned: today + "T00:00:00.000Z",
    superseded_by: "",
    volatility: "stable",
    verified: "",
    valid_at: today + "T00:00:00.000Z",
    invalid_at: "",
    conflicts_with: "",
    sensitivity: "normal",
    score: 0,
    owner_key: "",
    visibility_hold: 0,
    ...over,
  });
  const rows = [
    // 他名下的：private 也读得到 —— 挡的从来是跨房间，不是他自己看自己
    row({ id: "own", person: "来客·李", owner_key: "room:guest-a" }),
    // 同一个自报称呼、另一间屋的客人：称呼撞上了也翻不走 —— 归属键才是授权凭据
    row({ id: "other", person: "来客·李", owner_key: "room:guest-b" }),
    // 公开的：谁都读得到
    row({ id: "pub", visibility: "public" }),
    // 管理员的私事：默认这一档，出不了门
    row({ id: "secret", person: "管理员" }),
    // 存量数据：归属键是空串 —— 称呼对不上屋子就核实不了归属，不再对名下读取开放
    row({ id: "legacy", person: "来客·李", owner_key: "" }),
  ];

  // 门槛的放行规则和生产 SQL 一个意思：tag 精确命中（instr 逗号防子串）+ 量级序不超过门槛
  const RANK: Record<string, number> = {
    trivial: 0,
    normal: 1,
    important: 2,
    secret: 3,
    topsecret: 4,
  };
  const gateOpen = (r: { tags: string; sensitivity: string }) => {
    const ts = r.tags.split(",").filter(Boolean);
    return Object.entries(gates).some(
      ([t, lv]) =>
        ts.includes(t) && (RANK[r.sensitivity] ?? 1) <= (RANK[lv] ?? -1),
    );
  };
  let gates: Record<string, string> = {};

  // 有效公开判定（和生产 SQL 一个意思）：没被收回 +（手动公开或 tag 门）+ 绝密不出
  const out = (r: ReturnType<typeof row>) =>
    r.visibility_hold === 0 &&
    ((r.visibility === "public" && r.sensitivity !== "topsecret") ||
      gateOpen(r));

  function fakeSql() {
    const updates: string[] = [];
    const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join("?");
      if (q.startsWith("UPDATE")) {
        updates.push(q);
        return [];
      }
      // 来客受限读的那条查询：owner_key 是第一个绑定值（先认它 —— 只有这一路有 owner_key）
      if (q.includes("owner_key =")) {
        const key = String(vals[0]);
        return rows.filter(
          (r) =>
            // 他名下的不受收回挡：hold 压的是「自动放行」，不是「他翻自己的账」
            (r.owner_key !== "" && r.owner_key === key) || out(r),
        );
      }
      // onlyPublic 那条：有效公开（公开 + tag 门，减掉收回与绝密）
      if (q.includes("OR EXISTS")) {
        return rows.filter(out);
      }
      return rows;
    }) as unknown as SqlTag;
    return { tag, updates };
  }

  it("public 加本人名下（归属键对上）的都出，管理员的 private 不出；来客来问也不写权重", async () => {
    gates = {};
    const { tag, updates } = fakeSql();
    const env = {} as Parameters<typeof searchMemories>[1];
    const hits = await searchMemories(tag, env, "爬山", 5, {
      guestOwnerKey: "room:guest-a",
    });
    expect(hits.map((h) => h.id).sort()).toEqual(["own", "pub"]);
    // 权重记的是管理员自己用上过多少次，不该让外人的检索顶上去
    expect(updates.filter((q) => q.includes("SET weight")).length).toBe(0);
  });

  it("同昵称不同屋不可互读：报同一个称呼，只翻得到自己那间名下的", async () => {
    gates = {};
    const { tag } = fakeSql();
    const env = {} as Parameters<typeof searchMemories>[1];
    const hits = await searchMemories(tag, env, "爬山", 5, {
      guestOwnerKey: "room:guest-b",
    });
    // guest-b 翻得到公开档和自己名下的（other）——两行 person 都是「来客·李」，
    // 但 guest-a 名下的 own 和存量 legacy 一个字不出：称呼撞上了也没用
    expect(hits.map((h) => h.id).sort()).toEqual(["other", "pub"]);
  });

  it("存量数据（owner_key 为空串）不再对任何来客的名下读取开放", async () => {
    gates = {};
    const { tag } = fakeSql();
    const env = {} as Parameters<typeof searchMemories>[1];
    for (const key of ["room:guest-a", "room:guest-b"]) {
      const hits = await searchMemories(tag, env, "爬山", 5, {
        guestOwnerKey: key,
      });
      expect(hits.map((h) => h.id)).not.toContain("legacy");
    }
  });

  it("没报名的客人（guestOwnerKey 为空时不走这一路）仍走 onlyPublic：私事一个字不出", async () => {
    gates = {};
    const { tag, updates } = fakeSql();
    const env = {} as Parameters<typeof searchMemories>[1];
    const hits = await searchMemories(tag, env, "爬山", 5, {
      onlyPublic: true,
    });
    expect(hits.map((h) => h.id)).toEqual(["pub"]);
    expect(updates.filter((q) => q.includes("SET weight")).length).toBe(0);
  });

  it("tag 门开着、量级不超门槛的私事也出得去 —— 这就是按 tag 公开的全部意义", async () => {
    gates = { 爬山: "trivial" };
    const rowsWithGate = [
      row({ id: "gated", tags: "fact,爬山", sensitivity: "trivial" }),
      row({ id: "tooHigh", tags: "fact,爬山", sensitivity: "normal" }),
    ];
    const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join("?");
      if (q.startsWith("UPDATE")) return [] as never;
      if (q.includes("owner_key ="))
        return rowsWithGate.filter(
          (r) =>
            (r.owner_key !== "" && r.owner_key === String(vals[0])) || out(r),
        ) as never;
      return rowsWithGate.filter(out) as never;
    }) as unknown as SqlTag;
    const env = {} as Parameters<typeof searchMemories>[1];
    const hits = await searchMemories(tag, env, "爬山", 5, {
      guestOwnerKey: "room:guest-a",
    });
    expect(hits.map((h) => h.id)).toEqual(["gated"]);
  });

  it("收回（hold）压过一切自动放行：tag 门开着、手动公开标记还在，都出不了门", async () => {
    gates = { 爬山: "trivial" };
    const held = [
      // 收回过的：哪怕 tag 门对它开着
      row({
        id: "heldGate",
        tags: "fact,爬山",
        sensitivity: "trivial",
        visibility_hold: 1,
      }),
      // 收回过的：手动公开标记还挂着（管理员收回时没清标记，靠 hold 挡）
      row({ id: "heldPub", visibility: "public", visibility_hold: 1 }),
    ];
    const tag = ((strings: TemplateStringsArray) => {
      const q = strings.join("?");
      if (q.startsWith("UPDATE")) return [] as never;
      return held.filter(out) as never;
    }) as unknown as SqlTag;
    const env = {} as Parameters<typeof searchMemories>[1];
    // onlyPublic 一条字不出
    const pub = await searchMemories(tag, env, "爬山", 5, {
      onlyPublic: true,
    });
    expect(pub).toEqual([]);
    // 来客受限读同样不出
    const guest = await searchMemories(tag, env, "爬山", 5, {
      guestOwnerKey: "room:guest-a",
    });
    expect(guest).toEqual([]);
  });

  it("名下读取不受收回挡：hold 压的是自动放行，不是他翻自己的账", async () => {
    gates = {};
    const owned = [
      row({
        id: "ownHeld",
        owner_key: "room:guest-a",
        visibility_hold: 1,
      }),
    ];
    const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join("?");
      if (q.startsWith("UPDATE")) return [] as never;
      if (q.includes("owner_key ="))
        return owned.filter(
          (r) =>
            (r.owner_key !== "" && r.owner_key === String(vals[0])) || out(r),
        ) as never;
      return owned.filter(out) as never;
    }) as unknown as SqlTag;
    const env = {} as Parameters<typeof searchMemories>[1];
    const hits = await searchMemories(tag, env, "爬山", 5, {
      guestOwnerKey: "room:guest-a",
    });
    expect(hits.map((h) => h.id)).toEqual(["ownHeld"]);
  });

  it("先公开、后被改成绝密的存量也不出门：量级是人后改的，公开标记不替新量级做主", async () => {
    gates = {};
    const legacy = [
      row({ id: "tsPub", visibility: "public", sensitivity: "topsecret" }),
    ];
    const tag = ((strings: TemplateStringsArray) => {
      const q = strings.join("?");
      if (q.startsWith("UPDATE")) return [] as never;
      return legacy.filter(out) as never;
    }) as unknown as SqlTag;
    const env = {} as Parameters<typeof searchMemories>[1];
    const pub = await searchMemories(tag, env, "爬山", 5, {
      onlyPublic: true,
    });
    expect(pub).toEqual([]);
  });
});

/**
 * 向量层的加分必须是「有多相关」，不是「有没有进前几名」。
 *
 * 从前是命中就 +0.5，而关键词那一路一共只加 0.15～0.3：一个数就把另一把尺子
 * 盖掉了 —— 向量说好，就算好；向量层一坏，排序又完全换一套。
 * 这两条是钉这个的：弱相关盖不过关键词命中，强弱相关之间要分得出先后。
 */
describe("searchMemories 的向量加分", () => {
  const row = (id: string, content: string) => ({
    id,
    date: today,
    type: "fact",
    tags: "fact",
    weight: 0.5,
    shelf: "people",
    person: "",
    visibility: "private",
    content,
    accessed: 0,
    learned: today + "T00:00:00.000Z",
    superseded_by: "",
    volatility: "stable",
    verified: "",
    valid_at: today + "T00:00:00.000Z",
    invalid_at: "",
    conflicts_with: "",
  });

  function harness(
    rows: ReturnType<typeof row>[],
    matches: Array<{ id: string; score: number }>,
    vectorBroken = false,
  ) {
    const tag = ((strings: TemplateStringsArray) => {
      const q = strings.join("?");
      return q.startsWith("UPDATE") ? [] : rows;
    }) as unknown as SqlTag;
    const env = {
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
      VECTORIZE_INDEX: {
        query: async () => {
          if (vectorBroken) throw new Error("索引不可用");
          return { matches };
        },
      },
    } as unknown as Parameters<typeof searchMemories>[1];
    return { tag, env };
  }

  it("两条都被向量捞回来时，相关的排在不相关前面", async () => {
    // 顺序故意让弱相关那条先落进扫描池：固定加分时它是第一名（分数一样、按原序）
    const { tag, env } = harness(
      [row("weak", "周末去爬山"), row("strong", "爬山是他唯一的运动")],
      [
        { id: "weak", score: 0.55 },
        { id: "strong", score: 0.86 },
      ],
    );
    const hits = await searchMemories(tag, env, "爬山", 5);
    expect(hits[0].id).toBe("strong");
  });

  // 「弱相关向量压不过关键词命中」这条老用例已被相关性门槛吸收：
  // 0.35 门槛之下不存在能进门的弱向量，而能进门的向量命中（≥0.35）
  // 本来就该排在单一正文关键词命中（+0.15）前面 —— 这是合并重排的预期。

  it("检索有相关性门槛：两把尺子都不沾的，不占返回名额", async () => {
    const { tag, env } = harness(
      [
        // 关键词正面命中
        row("kw", "他说他常去爬山"),
        // 向量余弦过门槛
        row("vec", "周末的写作安排"),
        // 关键词不沾、向量又是「同领域但不相干」的弱分 —— 该被门槛挡下
        row("noise", "上周买的茶叶"),
      ],
      [
        { id: "vec", score: 0.6 },
        { id: "noise", score: 0.1 },
      ],
    );
    const hits = await searchMemories(tag, env, "爬山", 5);
    expect(hits.map((h) => h.id).sort()).toEqual(["kw", "vec"]);
  });

  it("关键词命中过门槛，哪怕向量层对它一无所知", async () => {
    const { tag, env } = harness(
      [row("kw", "他说他常去爬山")],
      [], // 向量层没给它分
    );
    const hits = await searchMemories(tag, env, "爬山", 5);
    expect(hits.map((h) => h.id)).toEqual(["kw"]);
  });

  it("向量层抛异常时退回纯关键词，检索照常出结果", async () => {
    const { tag, env } = harness([row("kw", "他说他常去爬山")], [], true);
    const hits = await searchMemories(tag, env, "爬山", 5);
    expect(hits.map((h) => h.id)).toEqual(["kw"]);
  });

  it("公开判定的三条 SQL 里都有 tag 门（EXISTS + 逗号防子串 + 绝密序最高）", async () => {
    const seen: string[] = [];
    const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      seen.push(strings.join("?").replace(/\s+/g, " "));
      // searchMemories 在扫描池为空时直接返回，不会去碰向量层
      return [] as never;
    }) as unknown as SqlTag;
    const env = {} as Parameters<typeof searchMemories>[1];
    listPublicMemories(tag, 10);
    await searchMemories(tag, env, "爬山", 5, { onlyPublic: true });
    await searchMemories(tag, env, "爬山", 5, {
      guestOwnerKey: "room:guest-a",
    });
    // 三条都得有门，而且三扇门得是同一扇：改 SQL 时漏掉任何一条，
    // 来客就能从那条路把没放行的记忆问出去
    expect(seen.length).toBe(3);
    for (const q of seen) {
      expect(q).toContain("FROM tag_access");
      // instr 两头补逗号：「ai」不许命中「email」这种子串
      expect(q).toContain(
        "instr(',' || memories.tags || ',', ',' || ta.tag || ',')",
      );
      // 门槛枚举到 secret 为止，绝密的序（4）在 CASE 里永远高过门槛（最高 3）
      expect(q).toContain("WHEN 'topsecret' THEN 4");
      expect(q).not.toContain("WHEN 'topsecret' THEN 0");
      // 收回闸三处都在：显式收回（hold=1）的记忆不靠 tag 门或公开标记出门
      expect(q).toContain("visibility_hold = 0");
      // public 半边也排绝密：先公开、后改档的存量出不了门
      expect(q).toContain("sensitivity <> 'topsecret'");
    }
    // 来客分支里，名下读取（owner_key 命中）必须落在收回闸之外 ——
    // hold 压的是自动放行，不是他翻自己的账
    expect(seen[2]).toContain("owner_key = ? OR (visibility_hold = 0");
  });
});

/**
 * 显式收回与绝密禁公开：setVisibility 是管理员手里「公开 / 收回」按钮的那只手。
 * 收回要单独落 hold（只改回 private 挡不住 tag 门），绝密要直接拒绝公开动作。
 */
describe("显式收回与绝密禁公开（setVisibility）", () => {
  const mk = () => {
    const row = { id: "m1", visibility: "private", sensitivity: "normal" };
    const vals0: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("SELECT * FROM memories WHERE id"))
        return row.id === vals[0] ? [row] : [];
      if (q.startsWith("UPDATE memories SET visibility")) {
        vals0.push(vals as unknown[]);
        row.visibility = String(vals[0]);
        return [] as never;
      }
      throw new Error("假的 sql 没认出这条语句：" + q);
    }) as unknown as SqlTag;
    return { sql, row, vals0 };
  };

  it("收回落 hold=1：tag 门再开也不出门；再点公开落 hold=0，重新放行", () => {
    const { sql, vals0 } = mk();
    const held = setVisibility(sql, "m1", "private");
    expect(held).toMatchObject({ visibility: "private", hold: true });
    expect(vals0[0][1]).toBe(1);
    const open = setVisibility(sql, "m1", "public");
    expect(open).toMatchObject({ visibility: "public", hold: false });
    expect(vals0[1][1]).toBe(0);
    // 查无此条返回 null，不抛
    expect(setVisibility(sql, "m404", "public")).toBeNull();
  });

  it("绝密拒绝公开动作：想公开，先把量级降下来 —— 次序不能反", () => {
    const { sql, row } = mk();
    row.sensitivity = "topsecret";
    expect(() => setVisibility(sql, "m1", "public")).toThrow(
      "绝密没有出门的路",
    );
    // 收回不受限：绝密本来就出不了门，把它钉死在收回态是无害操作
    expect(setVisibility(sql, "m1", "private")).not.toBeNull();
  });
});

/**
 * 量级与 tag 公开门槛的账本。
 * 绝密是这套设计的硬约束：AI 的工具枚举里没有它，tag 门槛也放不了它 ——
 * 这两条测试钉的就是「它没有出门的路」和「只有管理员手里有这把锁」。
 */
describe("量级与 tag 门槛（sensitivity / tag_access）", () => {
  it("setSensitivity 只有管理员的那一档是 10 分：设绝密钉 10，设别的档不动 AI 留的依据", () => {
    const row = {
      id: "m1",
      sensitivity: "normal",
      score: 6,
    };
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("SELECT * FROM memories WHERE id"))
        return row.id === vals[0] ? [row] : [];
      if (q.startsWith("UPDATE memories SET sensitivity")) {
        row.sensitivity = String(vals[0]);
        row.score = Number(vals[1]);
        return [] as never;
      }
      throw new Error("假的 sql 没认出这条语句：" + q);
    }) as unknown as SqlTag;

    const up = setSensitivity(sql, "m1", "topsecret");
    expect(up).toMatchObject({ sensitivity: "topsecret", score: 10 });
    // 回到普通档：分数不再动 —— 那是 AI 算的分，抹了就没法对账
    const down = setSensitivity(sql, "m1", "important");
    expect(down).toMatchObject({ sensitivity: "important", score: 10 });
    expect(setSensitivity(sql, "m404", "topsecret")).toBeNull();
  });

  it("setTagAccess 只认到机密；关门就是删行，硬递 topsecure 也进不了账", () => {
    const gates = new Map<string, string>();
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("DELETE FROM tag_access")) {
        gates.delete(String(vals[0]));
        return [] as never;
      }
      if (q.startsWith("INSERT OR REPLACE INTO tag_access")) {
        gates.set(String(vals[0]), String(vals[1]));
        return [] as never;
      }
      throw new Error("假的 sql 没认出这条语句：" + q);
    }) as unknown as SqlTag;

    setTagAccess(sql, " 爬山 ", "trivial");
    expect(gates.get("爬山")).toBe("trivial");
    // 门槛开到顶也只到 secret —— topsecret 不在枚举里，落成关门
    setTagAccess(sql, "爬山", "topsecret");
    expect(gates.has("爬山")).toBe(false);
    setTagAccess(sql, "爬山", "secret");
    expect(gates.get("爬山")).toBe("secret");
    // 关门关得干脆：'' 和认不出的值都是删
    setTagAccess(sql, "爬山", "");
    expect(gates.has("爬山")).toBe(false);
    setTagAccess(sql, "爬山", "随便什么");
    expect(gates.has("爬山")).toBe(false);
    setTagAccess(sql, "  ", "trivial");
    expect(gates.size).toBe(0);
  });

  it("tagStats 按逗号拆标签、按量级分档计数；认不出的量级落一般", () => {
    const rows = [
      { tags: "爬山,健康", sensitivity: "trivial" },
      { tags: "爬山", sensitivity: "secret" },
      { tags: "健康", sensitivity: "topsecret" },
      { tags: " 爬山 ,工作", sensitivity: "historical nonsense" },
      // 已作废的不进统计：不算数的记忆没有公开可言
      { tags: "爬山", sensitivity: "trivial", superseded_by: "m9" },
    ];
    const sql = ((strings: TemplateStringsArray) => {
      const q = strings.join("?");
      if (q.includes("SELECT tags, sensitivity FROM memories"))
        return rows.filter((r) => !r.superseded_by) as never;
      throw new Error("假的 sql 没认出这条语句：" + q);
    }) as unknown as SqlTag;
    const stats = tagStats(sql);
    expect(Object.fromEntries(stats.map((s) => [s.tag, s]))).toEqual({
      爬山: {
        tag: "爬山",
        n: 3,
        trivial: 1,
        normal: 1,
        important: 0,
        secret: 1,
        topsecret: 0,
      },
      健康: {
        tag: "健康",
        n: 2,
        trivial: 1,
        normal: 0,
        important: 0,
        secret: 0,
        topsecret: 1,
      },
      工作: {
        tag: "工作",
        n: 1,
        trivial: 0,
        normal: 1,
        important: 0,
        secret: 0,
        topsecret: 0,
      },
    });
    // 条数多的排前面
    expect(stats[0].tag).toBe("爬山");
  });

  it("insertMemory 落库带量级：没标/标错落一般，分数夹在 0-10", () => {
    const seen: Record<string, unknown>[] = [];
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("INSERT OR REPLACE INTO memories")) {
        seen.push({ sensitivity: vals[21], score: vals[22] });
        return [] as never;
      }
      throw new Error("假的 sql 没认出这条语句：" + q);
    }) as unknown as SqlTag;

    // INSERT 列序里 sensitivity / score 是最后两列（21 / 22），漏进 INSERT 就全落默认 —— 这里钉住位置
    const a = insertMemory(sql, {
      type: "fact",
      content: "x",
      sensitivity: "secret",
      score: 8,
    });
    expect(seen[0]).toEqual({ sensitivity: "secret", score: 8 });
    expect(a.sensitivity).toBe("secret");
    const b = insertMemory(sql, { type: "fact", content: "y" });
    expect(seen[1]).toEqual({ sensitivity: "normal", score: 0 });
    expect(b.sensitivity).toBe("normal");
    const c = insertMemory(sql, {
      type: "fact",
      content: "z",
      sensitivity: "topsecret" as never,
      score: 99,
    });
    expect(seen[2]).toEqual({ sensitivity: "topsecret", score: 10 });
    expect(c.score).toBe(10);
  });
});

describe("心跳裁剪的白名单：绝密、书册、近期活跃的不裁", () => {
  const PAST = new Date(Date.now() - 40 * 86400e3).toISOString();
  const RECENT = new Date(Date.now() - 2 * 86400e3).toISOString();
  const row = (over: Record<string, unknown> = {}) => ({
    id: "x",
    date: "2020-01-01",
    type: "fact",
    tags: "fact",
    weight: 0.1,
    shelf: "knowledge",
    person: "",
    visibility: "private",
    content: "低权重的老记忆",
    accessed: 0,
    learned: PAST,
    superseded_by: "",
    volatility: "stable",
    verified: "",
    valid_at: PAST,
    invalid_at: "",
    conflicts_with: "",
    sensitivity: "normal",
    score: 0,
    owner_key: "",
    visibility_hold: 0,
    dedupe_key: "",
    last_accessed_at: 0,
    session_id: "",
    sentiment: "",
    title: "",
    file_key: "",
    ...over,
  });

  function mkDb(rows: ReturnType<typeof row>[], boost = 797) {
    const deleted: string[] = [];
    // COUNT 报的数比实际多 797：把 5 行的测试库顶过 800 的软上限
    const fakeCount = rows.length + boost;
    const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("SELECT COUNT")) return [{ n: fakeCount }] as never;
      // 裁剪名单：白名单和生产 SQL 一个意思 —— 绝密、书册、近期活跃的不进候选
      if (q.startsWith("SELECT id, content FROM memories")) {
        const [learnedCut, protectCut, excess] = vals as [
          string,
          number,
          number,
        ];
        return rows
          .filter(
            (r) =>
              r.sensitivity !== "topsecret" &&
              r.type !== "book" &&
              String(r.learned) < learnedCut &&
              Number(r.last_accessed_at ?? 0) < protectCut,
          )
          .sort(
            (a, b) =>
              Number(a.session_id !== "") - Number(b.session_id !== "") ||
              a.weight - b.weight ||
              Number(a.last_accessed_at ?? 0) - Number(b.last_accessed_at ?? 0),
          )
          .slice(0, excess)
          .map((r) => ({ id: r.id, content: r.content })) as never;
      }
      if (q.startsWith("SELECT * FROM memories WHERE id"))
        return rows.filter((r) => r.id === vals[0]) as never;
      if (q.startsWith("SELECT * FROM memories WHERE conflicts_with"))
        return [] as never;
      if (q.startsWith("DELETE FROM memories WHERE id")) {
        deleted.push(String(vals[0]));
        const i = rows.findIndex((r) => r.id === vals[0]);
        if (i >= 0) rows.splice(i, 1);
        return [] as never;
      }
      if (q.startsWith("UPDATE memories SET conflicts_with"))
        return [] as never;
      throw new Error("假的 sql 没认出这条语句：" + q);
    }) as unknown as SqlTag;
    return { tag, deleted };
  }

  const agent = (db: SqlTag) =>
    ({
      db,
      keepAliveWhile: async (fn: () => Promise<void>) => fn(),
    }) as unknown as Parameters<typeof runHeartbeat>[0];
  const env = {} as Parameters<typeof runHeartbeat>[1];

  it("超限时只裁普通低权重老条目：绝密、书册、近期学到的都活下来", async () => {
    const db = mkDb([
      row({ id: "plain", content: "普通低权重" }),
      row({ id: "ts", sensitivity: "topsecret", content: "管理员钉的绝密" }),
      row({ id: "book", type: "book", title: "手册", content: "一篇心血" }),
      row({ id: "fresh", learned: RECENT, content: "刚学到的" }),
      // accessed 是次数不是时间，这里必须用 last_accessed_at 表达「最近还在被用」：
      // 以前拿次数比毫秒时间戳，这个保护条件恒真，形同虚设
      row({
        id: "busy",
        last_accessed_at: Date.now(),
        content: "最近还在被检索",
      }),
    ]);
    await runHeartbeat(agent(db.tag), env);
    expect(db.deleted).toEqual(["plain"]);
  });

  it("没超限就一条不裁", async () => {
    const rows = [row({ id: "plain" })];
    const db = mkDb(rows);
    // 直接把 fakeCount 顶回去：不多报 797 就是 798 条，没超限
    const tag = ((strings: TemplateStringsArray) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("SELECT COUNT")) return [{ n: 800 }] as never;
      throw new Error("不该有后续查询：" + q);
    }) as unknown as SqlTag;
    await runHeartbeat(agent(tag), env);
    expect(db.deleted).toEqual([]);
    expect(rows.length).toBe(1);
  });

  it("老记忆只要最近还被用过就不裁 —— 学得早不等于没在用", async () => {
    // boost 顶到 801：只有两行测试库也要跨过 800 的软上限
    const db = mkDb(
      [
        row({
          id: "aged-but-used",
          learned: PAST,
          last_accessed_at: Date.now() - 86400e3, // 昨天刚被检索命中过
          content: "老但常用",
        }),
        row({ id: "plain", content: "普通低权重" }),
      ],
      799,
    );
    await runHeartbeat(agent(db.tag), env);
    expect(db.deleted).toEqual(["plain"]);
  });
});
