/**
 * 画图这条路子上最容易出错的两段纯逻辑。
 *
 * 为什么不测 draw / diagram 本身：那两条要打外部接口、要 R2、要模型配合，
 * 测起来只是在测桩。但这两段不一样 ——
 *   extractSvg：SVG 是模型写的，它常常包着 ``` 围栏、前后带解释、偶尔还写重复的收尾标签；
 *   handOff   ：交出去的那行 markdown 是前端认图的唯一依据（Messages.tsx 的 Drawn），
 *               错一个字符，人就什么图都看不到。
 *   imageKeyIn：自检要按那个地址把图从云盘取回来重递一遍 —— 抠错就是「让她看一眼」，
 *               而她眼前什么都没有。
 * 这几处出错的症状是同一个：「她说画好了，他什么都没看见」，而那最难查。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import { extractSvg, handOff, imageKeyIn, selfCheck } from "../src/tools/draw";

describe("extractSvg", () => {
  it("干净的一段原样取出", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>';
    expect(extractSvg(svg)).toBe(svg);
  });

  it("包在 ``` 围栏里也认得出来", () => {
    const raw =
      '这是源码：\n```svg\n<svg viewBox="0 0 1 1"></svg>\n```\n就这样。';
    expect(extractSvg(raw)).toBe('<svg viewBox="0 0 1 1"></svg>');
  });

  it("前后带着解释文字，只取 <svg> 那一段", () => {
    const raw =
      '好的，我画了一张：\n<svg viewBox="0 0 1 1"><circle/></svg>\n上面就是这张图。';
    expect(extractSvg(raw)).toBe('<svg viewBox="0 0 1 1"><circle/></svg>');
  });

  it("少了收尾标签就不收（宁可让它重画，也别存半张坏图）", () => {
    expect(extractSvg('<svg viewBox="0 0 1 1"><rect/>')).toBeNull();
  });

  it("根本不是 SVG 就不收", () => {
    expect(extractSvg("我画不了这个。")).toBeNull();
  });
});

describe("handOff（交出去的那几句话）", () => {
  const url = "/api/files/diagram-1730000000000.svg";

  it("正文里那行是前端认得出的 markdown", () => {
    const out = handOff(
      `图已经画好了：${url}`,
      "登录流程",
      url,
      "SVG 示意 · 2KB",
      "",
    );
    expect(out).toContain(`![登录流程](${url})`);
  });

  it("替换文字里的方括号被剔掉 —— 它会把那行 markdown 拆散，人就看不到图", () => {
    const out = handOff("x", "图[1]", url, "m", "");
    expect(out).toContain(`![图1](${url})`);
    expect(out).not.toContain("![图[1]]");
  });

  it("交代清楚「原样放进回复」，并把存进记忆那句话说给模型听", () => {
    const out = handOff("x", "t", url, "SVG 示意 · 2KB", "\n已存进记忆 [m1]。");
    expect(out).toContain("原样放进你的回复");
    expect(out).toContain("已存进记忆 [m1]。");
  });
});

describe("画完自检（图递回去让她自己看一眼）", () => {
  it("第一版鼓励她看一眼、不对就重画 —— 但只许重画一次", () => {
    expect(selfCheck(1)).toContain("最多一次");
  });

  it("重画过的那一版到此为止：不劝第三次，也不再让她挑自己的毛病", () => {
    expect(selfCheck(2)).toContain("别再画第三版");
    expect(selfCheck(2)).not.toContain("最多一次");
  });

  /**
   * 自检靠 toModelOutput 按地址把图从云盘取回来 —— 地址是从工具结果那段文字里抠出来的。
   * 抠不到，图就递不回去，而她只收到一句「你自己看一眼」，眼前却没有图。
   * 前端 Drawn 用的是同一条正则：三处（handOff 写、这里读、前端渲染）必须对得上。
   */
  it("handOff 写进去的地址，抠得回来", () => {
    const path = "/api/files/draw-1730000000000.png";
    const out = handOff(
      `画好了：${path}`,
      "一只猫",
      path,
      "FLUX.2 klein · 1024x1024",
      "",
    );
    expect(imageKeyIn(out)).toBe("draw-1730000000000.png");
  });

  it("没有图的时候（比如没画成）抠出来是空的，别硬凑一个文件名", () => {
    expect(imageKeyIn("这次没画成：\nFLUX：HTTP 500")).toBeNull();
  });
});
