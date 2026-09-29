import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_PROMPT,
  RESTRAINT_BLOCK,
  buildBasePrompt,
  selfDemandBlock,
  stripToolGuide,
  toolGuide,
} from "../src/agent/prompt";

// 新工具说明的标题：编号风格，与守则（1-4）、收着（5）、深度模式（6）、自定守则（7）连成一篇
const TOOL_HEADING = "8、我能用的工具";
// 旧版快照里工具说明的标题（分家之前的格式），stripToolGuide 仍要能认出并剥掉
const LEGACY_HEADING = "## 我能用的工具";

describe("服务向文案边界", () => {
  it("默认守则与两份工具说明里不出现「小王」—— 他服务的是眼前的人，不点名台后的人", () => {
    expect(DEFAULT_BASE_PROMPT).not.toContain("小王");
    expect(toolGuide(false)).not.toContain("小王");
    expect(toolGuide(true)).not.toContain("小王");
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

describe("toolGuide", () => {
  it("两边都从同一个标题起头：它是一份说明，不是人设的一部分", () => {
    expect(toolGuide(false).startsWith("\n" + TOOL_HEADING)).toBe(true);
    expect(toolGuide(true).startsWith("\n" + TOOL_HEADING)).toBe(true);
  });

  it("主人那间写着任务、提醒、翻旧账、赞踩的用法，且不再有盯梢/承诺/发信", () => {
    const owner = toolGuide(false);
    for (const t of ["recall（", "task（", "remind（", "feedback（"]) {
      expect(owner).toContain(t);
    }
    // 三样已随副本裁掉：守则里写着、工具箱里没有，等于教我答应做不到的事
    for (const t of ["watch（", "promise（", "send_email"]) {
      expect(owner).not.toContain(t);
    }
  });

  it("来客那间不许出现那些工具 —— 写着却调不动，就会答应做不到的事", () => {
    const guest = toolGuide(true);
    for (const t of [
      "recall（",
      "task（",
      "remind（",
      "watch（",
      "send_email",
      "self",
      "note（",
    ]) {
      expect(guest).not.toContain(t);
    }
  });

  it("笔记本和记忆的分工写在主人那间：他要原稿，不是我的转述", () => {
    const owner = toolGuide(false);
    expect(owner).toContain("note（");
    expect(owner).toContain("用 note 而不是 memory");
    // 这条是「她看得到我在翻哪一篇」在提示词里的那一半：
    // 少了它，noteFocusBlock 注进去的那一段没人认领，她只会当背景读过去
    expect(owner).toContain("用户正在看的笔记");
    expect(owner).toContain("说清我动了哪几处");
  });

  it("来客那间只写它真有的那几个", () => {
    const guest = toolGuide(true);
    for (const t of [
      "search（",
      "read_url（",
      "browse（",
      "view_image（",
      "draw（",
    ]) {
      expect(guest).toContain(t);
    }
  });

  it("来客能翻公开与他名下的记忆，但翻不到就照实说", () => {
    const guest = toolGuide(true);
    expect(guest).toContain("memory 的 search");
    expect(guest).toContain("whoami");
    expect(guest).toContain("翻不到就照实说");
    expect(guest).toContain("编出来的记忆会让他误以为真");
    expect(guest).toContain("记忆库里翻到的");
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
    const guide = toolGuide(true);
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
