import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_PROMPT,
  RESTRAINT_BLOCK,
  buildBasePrompt,
  selfDemandBlock,
  stripToolGuide,
  toolGuide,
} from "../src/agent/prompt";
import {
  TOOLS,
  TOOL_GROUPS,
  guestEnabledTools,
  styleDefault,
  toolDefault,
} from "../src/agent/toolGroups";

// 工具说明的标题：编号风格，与守则（1-4）、收着（5）、深度模式（6）、自定守则（7）连成一篇
const TOOL_HEADING = "8、我能用的工具";
// 旧版快照里工具说明的标题（分家之前的格式），stripToolGuide 仍要能认出并剥掉
const LEGACY_HEADING = "## 我能用的工具";

describe("服务向文案边界", () => {
  it("默认守则与两份工具说明里不出现「小王」—— 他服务的是眼前的人，不点名台后的人", () => {
    expect(DEFAULT_BASE_PROMPT).not.toContain("小王");
    expect(toolGuide({ guest: false })).not.toContain("小王");
    expect(toolGuide({ guest: true })).not.toContain("小王");
  });
});

describe("stripToolGuide", () => {
  it("剥掉粘在人设尾巴上的旧工具说明", () => {
    const old =
      "我是张三。\n\n" + LEGACY_HEADING + "\n我有 search、remind 这些工具。";
    const out = stripToolGuide(old);
    expect(out).toBe("我是张三。");
    expect(out).not.toContain(LEGACY_HEADING);
  });

  it("编号版的新工具说明被抄进自定义守则时同样剥掉", () => {
    const pasted = "我是张三。\n\n" + TOOL_HEADING + "\n我有 search。";
    const out = stripToolGuide(pasted);
    expect(out).toBe("我是张三。");
    expect(out).not.toContain(TOOL_HEADING);
  });

  it("没有人设尾巴的原样留下 —— 剥离不能伤到人设本身", () => {
    const pure = "我是张三。我说话轻声，不绕圈子。";
    expect(stripToolGuide(pure)).toBe(pure);
  });
});

describe("toolGuide：语义组 → 逐工具两层", () => {
  it("两边都从同一个标题起头：它是一份说明，不是人设的一部分", () => {
    expect(toolGuide({ guest: false }).startsWith("\n\n" + TOOL_HEADING)).toBe(
      true,
    );
    expect(toolGuide({ guest: true }).startsWith("\n\n" + TOOL_HEADING)).toBe(
      true,
    );
  });

  it("组按名册的序出现，组里一件一件列，常驻/渐进标清楚", () => {
    const owner = toolGuide({ guest: false });
    for (const g of TOOL_GROUPS) expect(owner).toContain(`【${g.label}】`);
    // 常驻的直呼其名，渐进的得点名走网关 —— 不点明它就会直接调一个不存在的东西
    expect(owner).toContain("- search（直接调）—— ");
    expect(owner).toContain("- task（经 call_tool 调）—— ");
  });

  it("出厂稿逐件落到位：名册里给主人写的每句都在", () => {
    const owner = toolGuide({ guest: false });
    for (const t of TOOLS.filter((x) => x.owner && x.ownerDefault))
      expect(owner).toContain(t.ownerDefault);
  });

  it("主人有、来客没有的那些不向来客漏", () => {
    const guest = toolGuide({ guest: true });
    for (const n of [
      "recall",
      "session_memo",
      "note",
      "files",
      "task",
      "remind",
      "ask",
      "openSession",
      "self",
      "skill",
      "stats",
      "organize",
      "set_think_mode",
      "feedback",
    ])
      expect(guest).not.toContain(`- ${n}（`);
    // 来客独有的留痕在
    expect(guest).toContain("- visitor_log（");
  });

  it("来客那间只列它真有的那几件", () => {
    const guest = toolGuide({ guest: true });
    for (const n of [
      "search",
      "read_url",
      "browse",
      "weather",
      "view_image",
      "draw",
      "diagram",
      "send_image",
      "artifact",
      "memory",
      "visitor_log",
    ])
      expect(guest).toContain(`- ${n}（`);
  });
});

describe("来客那间按档位剪一遍", () => {
  it("档位关掉的工具不出现在说明里；恒开的照样在", () => {
    const guest = toolGuide({
      guest: true,
      enabled: guestEnabledTools(["search"]),
    });
    expect(guest).toContain("- search（");
    expect(guest).not.toContain("- draw（");
    expect(guest).not.toContain("- memory（");
    // 天气/识图/卡片/留痕没有关掉的路
    expect(guest).toContain("- weather（");
    expect(guest).toContain("- visitor_log（");
  });

  it("不给 enabled 时全列 —— 老票、老 state 的兜底", () => {
    expect(toolGuide({ guest: true })).toContain("- memory（");
  });
});

describe("逐工具 / 组尾 / 末栏 三处都能改", () => {
  it("逐工具覆盖：改了 search 不牵动 draw", () => {
    const g = toolGuide({
      guest: false,
      prompts: { search: "只搜官方文档。" },
    });
    expect(g).toContain("- search（直接调）—— 只搜官方文档。");
    expect(g).not.toContain(toolDefault("search", false));
    expect(g).toContain(toolDefault("draw", false));
  });

  it("空覆盖回落到出厂稿", () => {
    expect(toolGuide({ guest: false, prompts: { search: "  " } })).toBe(
      toolGuide({ guest: false }),
    );
    expect(toolGuide({ guest: false, style: "" })).toBe(
      toolGuide({ guest: false }),
    );
  });

  it("组尾覆盖替换本组那一段", () => {
    const g = toolGuide({
      guest: false,
      groupNotes: { read: "本组的话：先搜再读，别顺着链接逛。" },
    });
    expect(g).toContain("本组的话：先搜再读，别顺着链接逛。");
  });

  it("末栏风格覆盖替换出厂那份", () => {
    const g = toolGuide({
      guest: false,
      style: "调用纪律：一次一件，别乱发。",
    });
    expect(
      g.startsWith("\n\n" + TOOL_HEADING + "\n调用纪律：一次一件，别乱发。"),
    ).toBe(true);
    expect(g).not.toContain("主动开口花的是他的注意力");
  });
});

describe("工具使用风格该写明的两件事", () => {
  it("主人那间：他默认已经看过我说的每条消息 —— 没人接话不等于没看到", () => {
    expect(styleDefault(false)).toContain("默认已经看过");
    expect(styleDefault(false)).toContain("不是没看到");
  });

  it("来客那间：以「没有哪些工具」为准，绝不编造不存在的功能", () => {
    expect(styleDefault(true)).toContain("没有哪些工具");
    expect(styleDefault(true)).toContain("绝不编造不存在的功能");
  });
});

describe("buildBasePrompt", () => {
  it("空人设回落到出厂人设", () => {
    expect(buildBasePrompt("normal", "")).toBe(
      DEFAULT_BASE_PROMPT + RESTRAINT_BLOCK,
    );
    expect(buildBasePrompt("normal", "   ")).toBe(
      DEFAULT_BASE_PROMPT + RESTRAINT_BLOCK,
    );
  });

  it("人设里不再夹带工具清单：工具说明是另一份，由 toolGuide 单独给", () => {
    // 出厂人设本身就不该有那一段
    expect(DEFAULT_BASE_PROMPT).not.toContain(TOOL_HEADING);
    expect(DEFAULT_BASE_PROMPT).not.toContain(LEGACY_HEADING);
    // 自定义人设里粘着的旧版本也要被剥掉，否则会拼出两份、其中一份还是错的
    const legacy =
      "我是张三，一个自定义的我。\n\n" + LEGACY_HEADING + "\n我有 remind。";
    expect(buildBasePrompt("normal", legacy)).toBe(
      "我是张三，一个自定义的我。" + RESTRAINT_BLOCK,
    );
  });

  it("收敛规则不由人设保管：换了自定义人设，它照样接着", () => {
    // 存量房间的 state.basePrompt 存的是播种那天的快照，写进人设就等于冻住 ——
    // 这条治的是「她太爱分析」，得改得动、也得对老房间立刻生效
    const custom = buildBasePrompt("normal", "我是张三，一个自定义的我。");
    expect(custom).toContain("什么时候我先收着");
    expect(custom.indexOf("什么时候我先收着")).toBeGreaterThan(
      custom.indexOf("我是张三，一个自定义的我。"),
    );
  });

  it("深度模式是加在后面的模式修饰，盖不掉人设", () => {
    const deep = buildBasePrompt("deep", "我是张三。");
    expect(deep.startsWith("我是张三。")).toBe(true);
    expect(deep).toContain("深度思考模式");
    // 深度模式排在收敛规则后面：想得深和收得住是两件事，后一件不该被前一件盖掉
    expect(deep.indexOf("深度思考模式")).toBeGreaterThan(
      deep.indexOf("什么时候我先收着"),
    );
    expect(buildBasePrompt("normal", "我是张三。")).toBe(
      "我是张三。" + RESTRAINT_BLOCK,
    );
  });
});

describe("selfDemandBlock", () => {
  it("空着也照样出现 —— 空着本身就是一种状态", () => {
    const b = selfDemandBlock("");
    expect(b).toContain("我给自己定的守则");
    expect(b).toContain("还空着");
  });

  it("写过就把原文摆出来", () => {
    const b = selfDemandBlock("我答应过的事，想不起来也要去翻一下。");
    expect(b).toContain("我答应过的事，想不起来也要去翻一下。");
    expect(b).not.toContain("还空着");
  });

  it("标题点明出处是自己定的 —— 说一次就够，不反复自证", () => {
    expect(selfDemandBlock("")).toContain("这一块是我自己写的");
    expect(selfDemandBlock("不轻易说「我记住了」")).toContain(
      "这一块是我自己写的",
    );
    // 反复声明「这是我自己定的」反而是此地无银 —— 不出现在正文里
    expect(selfDemandBlock("不轻易说「我记住了」")).not.toContain(
      "我自己给自己定的",
    );
  });

  it("前面留空行：它是独立的一块，不该和上一段黏在一起", () => {
    expect(selfDemandBlock("随便什么").startsWith("\n\n7、")).toBe(true);
  });
});

describe("人设与工具说明分家之后，拼出来的四段各就各位", () => {
  it("人设里没有工具清单，工具说明在单独一份里，中间夹着自我要求", () => {
    const base = buildBasePrompt("normal", "");
    const demand = selfDemandBlock("我想成为他不开口也敢信的那种人。");
    const guide = toolGuide({ guest: true });
    const system = base + demand + guide;

    expect(system.indexOf("我想成为他不开口也敢信的那种人。")).toBeGreaterThan(
      system.indexOf(base.slice(0, 20)),
    );
    expect(system.indexOf(TOOL_HEADING)).toBeGreaterThan(
      system.indexOf("我想成为他不开口也敢信的那种人。"),
    );
    // 全篇只出现一次工具说明
    expect(system.split(TOOL_HEADING).length - 1).toBe(1);
  });
});
