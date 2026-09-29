/**
 * 对话内附件测试。
 *
 * 这里测的是「怎么读一份文件」里不靠网络的那一半：按什么判类型、拼出来的那段正文长什么样。
 * 真正去读（看图、抽 PDF、转写）要打外网，测不了也不该在单测里测。
 *
 * 拼正文这件事值得一条测试，是因为它是前后端之间的一条隐式约定：
 * 后端 attachBlock 拼出来的格式，前端 Messages.tsx 的 splitAttach 要能拆开。
 * 格式一改而对面没跟上，用户看到的就是一屏原始转录 —— 而且不报错，很难发现。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import {
  ATTACH_CLOSE,
  ATTACH_OPEN,
  attachBlock,
  kindOf,
  type Attachment,
} from "../src/agent/attach";

const at = (over: Partial<Attachment> = {}): Attachment => ({
  kind: "text",
  name: "note.txt",
  size: 100,
  text: "正文",
  note: "12 字",
  ...over,
});

describe("kindOf：按名字和 MIME 判该走哪条链路", () => {
  it("MIME 说了算的时候听 MIME", () => {
    expect(kindOf("微信图片_2026", "image/png")).toBe("image");
    expect(kindOf("无后缀的录音", "audio/mpeg")).toBe("audio");
    expect(kindOf("未知二进制", "video/mp4")).toBe("video");
  });

  it("MIME 缺了就看后缀", () => {
    expect(kindOf("合同.pdf", "")).toBe("pdf");
    expect(kindOf("日志.LOG", "")).toBe("text");
    expect(kindOf("录音.m4a", "application/octet-stream")).toBe("audio");
    expect(kindOf("片子.mov", "")).toBe("video");
  });

  it("json / xml 这类带 +json 后缀的也算文本", () => {
    expect(kindOf("data", "application/json")).toBe("text");
    expect(kindOf("feed", "application/rss+xml")).toBe("text");
  });

  it("认不出来就是 unknown，不硬塞进文本那条路", () => {
    expect(kindOf("mystery.bin", "")).toBe("unknown");
    expect(kindOf("installer.exe", "application/octet-stream")).toBe("unknown");
  });
});

describe("attachBlock：拼给模型看的那段正文", () => {
  it("有正文时用标记把正文包起来，前端才拆得开", () => {
    const s = attachBlock(
      at({ name: "报告.pdf", kind: "pdf", note: "抽到 800 字" }),
    );
    expect(s).toContain("【附件：报告.pdf（PDF · 抽到 800 字）】");
    expect(s).toContain(ATTACH_OPEN);
    expect(s).toContain(ATTACH_CLOSE);
    expect(s.indexOf(ATTACH_OPEN)).toBeLessThan(s.indexOf("正文"));
  });

  it("没读到正文时只留一行说明，不留一个空壳标记", () => {
    const s = attachBlock(at({ text: "", note: "这份 PDF 里抽不出文字" }));
    expect(s).toBe("【附件：note.txt（文本 · 这份 PDF 里抽不出文字）】");
    expect(s).not.toContain(ATTACH_OPEN);
  });
});

describe("前后端的约定：前端按同样的标记拆得回来", () => {
  // 前端 splitAttach 的正则（web/src/components/Messages.tsx）。
  // 两边不能互相 import（跨 node/web 边界），所以在这里把约定钉住。
  const RE = /【附件：([\s\S]*?)】(?:\n<<<附件正文\n([\s\S]*?)\n附件正文>>>)?/g;

  it("拆出来是「文件名（类型 · 结论）」和正文", () => {
    const s = attachBlock(
      at({ name: "a.pdf", kind: "pdf", note: "抽到 3 字", text: "甲乙丙" }),
    );
    const m = RE.exec(s);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("a.pdf（PDF · 抽到 3 字）");
    expect(m![2]).toBe("甲乙丙");
  });

  it("正文里再出现「附件正文」这四个字也不会把后一半吃掉", () => {
    const s = attachBlock(
      at({ text: "他说：附件正文这四个字是文件里本来就有的" }),
    );
    RE.lastIndex = 0;
    const m = RE.exec(s);
    expect(m![2]).toBe("他说：附件正文这四个字是文件里本来就有的");
  });
});
