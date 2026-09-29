import { describe, expect, it } from "vitest";
import {
  tidyTitle,
  titlePrompt,
  titleSystem,
  TITLE_SYSTEM,
} from "../src/agent/title";
import { mimoAnthropicBase, mimoChatUrl, mimoHost } from "../src/mimo";

describe("tidyTitle", () => {
  it("干干净净的一行原样留下", () => {
    expect(tidyTitle("帮管理员改简历")).toBe("帮管理员改简历");
  });

  it("只取第一个非空行 —— 它后面常常还跟着一句解释", () => {
    expect(tidyTitle("\n\n帮管理员改简历\n理由：他明天要投")).toBe(
      "帮管理员改简历",
    );
  });

  it("剥掉「标题：」这类前缀", () => {
    expect(tidyTitle("标题：帮管理员改简历")).toBe("帮管理员改简历");
    expect(tidyTitle("会话名: 帮管理员改简历")).toBe("帮管理员改简历");
  });

  it("剥掉成对的引号书名号，只脱一层", () => {
    expect(tidyTitle("「帮管理员改简历」")).toBe("帮管理员改简历");
    expect(tidyTitle("《帮管理员改简历》")).toBe("帮管理员改简历");
    expect(tidyTitle('"帮管理员改简历"')).toBe("帮管理员改简历");
    // 内容里本来就有的括号不该被一起吃光
    expect(tidyTitle("改简历（第一版）")).toBe("改简历（第一版）");
  });

  it("去掉结尾的句号感叹号 —— 标题不是句子", () => {
    expect(tidyTitle("帮管理员改简历。")).toBe("帮管理员改简历");
    expect(tidyTitle("帮管理员改简历！")).toBe("帮管理员改简历");
  });

  it("把行内的换行和多余空格压平", () => {
    expect(tidyTitle("帮管理员   改简历")).toBe("帮管理员 改简历");
  });

  it("太长就截到 20 个字", () => {
    expect(tidyTitle("一".repeat(50))).toHaveLength(20);
  });

  it("什么都没给就返回空 —— 调用方据此判断「这次没起成」", () => {
    expect(tidyTitle("")).toBe("");
    expect(tidyTitle("   \n  ")).toBe("");
    expect(tidyTitle("。")).toBe("");
  });
});

describe("titlePrompt", () => {
  it("带上开场白和用户的话", () => {
    const p = titlePrompt("帮我看个东西", "这是份简历");
    expect(p).toContain("用户说：帮我看个东西");
    expect(p).toContain("我回：这是份简历");
  });

  it("被打断、一个字都没说出来时，不编一句「我回：」", () => {
    const p = titlePrompt("帮我看个东西", "   ");
    expect(p).not.toContain("我回：");
  });

  it("来客那场用「来客说」，不带主人房间里的称呼", () => {
    const p = titlePrompt("帮我看个东西", "这是份简历", true);
    expect(p).toContain("来客说：帮我看个东西");
    expect(p).not.toContain("用户说：");
  });
});

describe("TITLE_SYSTEM", () => {
  it("明确禁掉引号和前缀 —— 它照样会加回来，所以退路上还得再收拾一遍", () => {
    expect(TITLE_SYSTEM).toContain("不要引号");
    expect(TITLE_SYSTEM).toContain("标题：");
  });

  it("本体不认人 —— 谁在说话由 titleSystem 补，默认那行留给管理员", () => {
    expect(TITLE_SYSTEM).not.toContain("小王");
    expect(titleSystem(false)).toContain("和你说话的是管理员本人");
    expect(titleSystem(true)).toContain("和你说话的是来客");
  });

  it("来客那间不给说话的人安任何称呼 —— 否则他的会话会被记成别人说的", () => {
    const guest = titleSystem(true);
    expect(guest).toContain("不要用「管理员」或任何人名");
  });
});

describe("MiMo 地址分路", () => {
  const env = (key: string) => ({ MIMO_API_KEY: key }) as unknown as Env;

  it("tp- 走 Token Plan 集群，sk- 走按量付费，两边互不通用", () => {
    expect(mimoHost(env("tp-abc"))).toBe(
      "https://token-plan-cn.xiaomimimo.com",
    );
    expect(mimoHost(env("sk-abc"))).toBe("https://api.xiaomimimo.com");
  });

  it("Anthropic 根地址必须带 /v1 —— AI SDK 只往后补 /messages，不补 /v1", () => {
    // 少了这一层小米会直接 404（DeepSeek 两个路径都收，所以照抄主线配置看不出来）
    expect(mimoAnthropicBase(env("tp-abc"))).toBe(
      "https://token-plan-cn.xiaomimimo.com/anthropic/v1",
    );
  });

  it("OpenAI 兼容的合成地址带完整路径", () => {
    expect(mimoChatUrl(env("sk-abc"))).toBe(
      "https://api.xiaomimimo.com/v1/chat/completions",
    );
  });

  it("环境变量给了就用它 —— 第三方转发站不按官方的域名来", () => {
    const custom = {
      MIMO_API_KEY: "tp-abc",
      MIMO_API_BASE: " https://relay.example/anthropic/v1 ",
    } as unknown as Env;
    expect(mimoAnthropicBase(custom)).toBe(
      "https://relay.example/anthropic/v1",
    );
  });
});
