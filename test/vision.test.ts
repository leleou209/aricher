// view_image 的房间划界：key 是模型随手给的，必须先划界再碰桶。
// 从前 analyzeUpload / view_image 拿到 key 就直接读 R2 —— 知道别家 key 的
// 持卡来客能把别人的附件和图读走。这里的用例钉住「拒绝时不碰桶」这一半：
// 只有桶的 get 一次都没被调过，才能证明门是真的挡住了，而不是读完再说。
import { describe, expect, it } from "vitest";
import { visionTools } from "../src/tools/vision";
import type { ToolCtx } from "../src/tools/types";

function ctxOf(room: string, guest: boolean) {
  const gets: string[] = [];
  const env = {
    MEMORY_BUCKET: {
      get: async (key: string) => {
        gets.push(key);
        return null; // 门过了也只是「没有这个文件」——这里只关心有没有碰桶
      },
    },
  };
  const ctx = { env, room, guest } as unknown as ToolCtx;
  return { ctx, gets };
}

/** view_image 是原生 AI SDK tool；这里只喂输入，不管 execute 的第二个参数 */
function viewOf(ctx: ToolCtx) {
  const t = visionTools(ctx).view_image as unknown as {
    execute: (a: unknown) => Promise<string>;
    toModelOutput: (a: {
      toolCallId: string;
      input: { key: string };
      output: string;
    }) => Promise<unknown>;
  };
  return t;
}

describe("view_image 的房间划界", () => {
  it("来客读别房的 key：拒绝，且桶一次都不碰", async () => {
    const { ctx, gets } = ctxOf("guest-ab12", true);
    const out = await viewOf(ctx).execute({ key: "f/default/secret.png" });
    expect(out).toContain("看不到");
    expect(gets).toEqual([]);
  });

  it("来客读本房前缀和公开空间的 key：放行去桶里找", async () => {
    const { ctx, gets } = ctxOf("guest-ab12", true);
    await viewOf(ctx).execute({ key: "f/guest-ab12/draw-1-x.png" });
    expect(gets).toEqual(["f/guest-ab12/draw-1-x.png"]);
    const { ctx: ctx2, gets: gets2 } = ctxOf("guest-ab12", true);
    await viewOf(ctx2).execute({ key: "f/public/poster-1.png" });
    expect(gets2).toEqual(["f/public/poster-1.png"]);
  });

  it("管理员那间全库可见：别人的前缀也放行", async () => {
    const { ctx, gets } = ctxOf("default", false);
    await viewOf(ctx).execute({ key: "f/guest-ab12/draw-1-x.png" });
    expect(gets).toEqual(["f/guest-ab12/draw-1-x.png"]);
  });

  it("execute 拒过的 key，toModelOutput 也不递图 —— 拒绝不能只是走个形式", async () => {
    const { ctx, gets } = ctxOf("guest-ab12", true);
    const out = await viewOf(ctx).toModelOutput({
      toolCallId: "call-1",
      input: { key: "f/default/secret.png" },
      output: "这就是 f/default/secret.png 的原图，自己看。",
    });
    // 只回文字，不带 image-data 块；桶也没被碰
    expect(JSON.stringify(out)).not.toContain("image-data");
    expect(gets).toEqual([]);
  });
});
