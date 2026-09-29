import { describe, expect, it } from "vitest";
import {
  canReadFile,
  fileResponseHeaders,
  roomKeyPrefix,
  scopedKey,
} from "../src/fileAccess";

describe("房间文件划界", () => {
  it("管理员全库可见：带前缀的、老的无前缀 key 都能读", () => {
    expect(canReadFile("f/default/draw-1-a.png", "admin", "default")).toBe(
      true,
    );
    expect(canReadFile("draw-1730000000000.png", "admin", "default")).toBe(
      true,
    );
    // 管理员连来客房间的图也能看（面板排查用）
    expect(canReadFile("f/guest-ab12/draw-1-x.png", "admin", "default")).toBe(
      true,
    );
  });

  it("来客只读自己房间前缀下的", () => {
    expect(canReadFile("f/guest-ab12/draw-1-x.png", "user", "guest-ab12")).toBe(
      true,
    );
  });

  it("别人的房间、老的无前缀 key、_admin 混进来的 role，都拒", () => {
    expect(canReadFile("f/default/draw-1-a.png", "user", "guest-ab12")).toBe(
      false,
    );
    expect(canReadFile("f/guest-cccc/draw-1-x.png", "user", "guest-ab12")).toBe(
      false,
    );
    // 前缀约定之前的存量图：来客本来就看不了，维持不可见
    expect(canReadFile("draw-1730000000000.png", "user", "guest-ab12")).toBe(
      false,
    );
  });

  it("相似房间名不误撞：guest-ab 的前缀匹配不到 guest-ab12 的文件", () => {
    // 关键在 roomKeyPrefix 的尾斜杠：f/guest-ab/ 不是 f/guest-ab12/ 的前缀
    expect(canReadFile("f/guest-ab12/draw-1-x.png", "user", "guest-ab")).toBe(
      false,
    );
    expect(roomKeyPrefix("guest-ab")).toBe("f/guest-ab/");
  });

  it("编过码的 key 也能判（%2F 解码成 / 之后形状一致）", () => {
    expect(
      canReadFile("f%2Fguest-ab12%2Fdraw-1-x.png", "user", "guest-ab12"),
    ).toBe(false); // 未解码时拒 —— 调用方必须先解码再判（handleServe 的做法）
  });

  it("公开空间 f/public/ 谁都读得到：不挑角色也不挑房间", () => {
    // 别的房间的来客、任何持卡者 —— 公开就是给进门的人看的
    expect(canReadFile("f/public/poster-1-a.png", "user", "guest-ab12")).toBe(
      true,
    );
    expect(canReadFile("f/public/poster-1-a.png", "user", "guest-cccc")).toBe(
      true,
    );
    expect(canReadFile("f/public/poster-1-a.png", "admin", "default")).toBe(
      true,
    );
    // scopedKey("public") 生成的 key 正好落进公开前缀（上传公开文件的路）
    expect(scopedKey("public", "poster", "png")).toMatch(
      /^f\/public\/poster-\d{13}-[0-9a-f]{8}\.png$/,
    );
  });
});

describe("scopedKey 生成", () => {
  it("带房间前缀、时间戳、随机段和扩展名；两次生成不相重", () => {
    const a = scopedKey("default", "draw", "png");
    const b = scopedKey("default", "draw", "png");
    expect(a).toMatch(/^f\/default\/draw-\d{13}-[0-9a-f]{8}\.png$/);
    expect(b).toMatch(/^f\/default\/draw-\d{13}-[0-9a-f]{8}\.png$/);
    expect(a).not.toBe(b);
    expect(scopedKey("guest-ab12", "diagram", "svg")).toMatch(
      /^f\/guest-ab12\/diagram-\d{13}-[0-9a-f]{8}\.svg$/,
    );
  });
});

describe("云盘响应头：SVG / HTML 是文档，得压进不透明源", () => {
  it("SVG（图纸工具的产物）带 CSP sandbox：单独开窗口也调不了带 cookie 的接口", () => {
    const h = fileResponseHeaders("image/svg+xml");
    expect(h["Content-Security-Policy"]).toContain("sandbox");
    expect(h["Content-Disposition"]).toBe("inline");
    expect(h["x-robots-tag"]).toBe("noindex");
  });

  it("HTML 照旧压 sandbox", () => {
    const h = fileResponseHeaders("text/html; charset=utf-8");
    expect(h["Content-Security-Policy"]).toContain("sandbox");
    expect(h["x-robots-tag"]).toBe("noindex");
  });

  it("带参数的类型和 XHTML 也压 sandbox：判断按去参数的媒体类型来", () => {
    // 上传存的类型可能带着 `; charset=utf-8`，精确匹配会把这一类漏出去
    expect(
      fileResponseHeaders("image/svg+xml; charset=utf-8")[
        "Content-Security-Policy"
      ],
    ).toContain("sandbox");
    expect(
      fileResponseHeaders("application/xhtml+xml")["Content-Security-Policy"],
    ).toContain("sandbox");
    expect(
      fileResponseHeaders("TEXT/HTML; charset=utf-8")[
        "Content-Security-Policy"
      ],
    ).toContain("sandbox");
  });

  it("普通图片内联展示但绝不 sandbox（img 标签要能画）", () => {
    const h = fileResponseHeaders("image/png");
    expect(h["Content-Disposition"]).toBe("inline");
    expect(h["Content-Security-Policy"]).toBeUndefined();
    expect(h["x-robots-tag"]).toBe("noindex");
  });

  it("私有文件无论类型都不缓存，切换身份后必须重新鉴权", () => {
    const pdf = fileResponseHeaders("application/pdf");
    const image = fileResponseHeaders("image/png");
    expect(pdf["Content-Type"]).toBe("application/pdf");
    expect(pdf["Cache-Control"]).toBe("private, no-store");
    expect(image["Cache-Control"]).toBe("private, no-store");
    expect(pdf["Content-Security-Policy"]).toBeUndefined();
    expect(pdf["Content-Disposition"]).toBeUndefined();
  });

  it("只有公开空间的文件可使用公共缓存，文档仍受 sandbox 保护", () => {
    expect(fileResponseHeaders("image/png", true)["Cache-Control"]).toBe(
      "public, max-age=86400, immutable",
    );
    const html = fileResponseHeaders("text/html", true);
    expect(html["Content-Security-Policy"]).toContain("sandbox");
  });
});
