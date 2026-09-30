// files 工具的 mkdir / move：文件夹是 key 路径的纯约定，move 是 copy+delete。
// 这里用一只内存桶钉住几件不能破的事：路径洗净挡上跳、来客出不了自己那间、
// 单对象与文件夹两种搬法都对、搬进自己子目录要被拒。
import { describe, expect, it } from "vitest";
import { fileTools } from "../src/tools/files";
import type { ToolCtx } from "../src/tools/types";

/** 内存桶：put/get/delete/list 够工具用；body 一律按字符串（工具只搬小东西） */
function memBucket() {
  const store = new Map<string, { body: string; httpMetadata?: unknown }>();
  return {
    store,
    async put(
      key: string,
      body: string,
      opts?: { httpMetadata?: unknown },
    ): Promise<void> {
      store.set(key, { body, httpMetadata: opts?.httpMetadata });
    },
    async get(key: string) {
      const hit = store.get(key);
      if (!hit) return null;
      return { ...hit, body: hit.body, text: async () => hit.body };
    },
    async head(key: string) {
      return store.has(key) ? { key } : null;
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(opts: { prefix?: string }) {
      const prefix = opts.prefix ?? "";
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return {
        objects: keys.map((key) => ({
          key,
          size: store.get(key)?.body.length ?? 0,
          uploaded: new Date(),
        })),
        truncated: false,
      };
    },
  };
}

function ctxOf(bucket: ReturnType<typeof memBucket>, guest = false) {
  return {
    env: { MEMORY_BUCKET: bucket },
    room: "default",
    guest,
  } as unknown as ToolCtx;
}

function filesOf(ctx: ToolCtx) {
  return fileTools(ctx).files as unknown as {
    execute: (a: Record<string, unknown>) => Promise<string>;
  };
}

describe("files 工具：mkdir", () => {
  it("建夹塞 .keep 占位对象，多级路径一次成型", async () => {
    const bucket = memBucket();
    const out = await filesOf(ctxOf(bucket)).execute({
      action: "mkdir",
      path: "f/default/个人/合同",
    });
    expect(out).toContain("建好了");
    expect(bucket.store.has("f/default/个人/合同/.keep")).toBe(true);
  });

  it("上跳路径拒绝：.. 出不去，桶里也不该多出东西", async () => {
    const bucket = memBucket();
    const out = await filesOf(ctxOf(bucket)).execute({
      action: "mkdir",
      path: "f/default/../../别人家",
    });
    expect(out).toContain("用不了");
    expect(bucket.store.size).toBe(0);
  });

  it("来客只能在自己房间前缀里建夹", async () => {
    const bucket = memBucket();
    const ctx = ctxOf(bucket, true);
    const out = await filesOf(ctx).execute({
      action: "mkdir",
      path: "f/guest-ab12/我的文件夹",
    });
    // ctx.room 是 default，来客前缀对不上 —— 被范围检查拦下
    expect(out).toContain("自己那间");
    expect(bucket.store.size).toBe(0);
  });
});

describe("files 工具：move", () => {
  it("单对象移动：内容跟过去，旧 key 消失；同目录换名就是改名", async () => {
    const bucket = memBucket();
    await bucket.put("f/default/会话/s-1/draw-1-a.png", "PNGDATA");
    const out = await filesOf(ctxOf(bucket)).execute({
      action: "move",
      key: "f/default/会话/s-1/draw-1-a.png",
      to: "f/default/个人/猫.png",
    });
    expect(out).toContain("搬好了");
    expect(bucket.store.get("f/default/个人/猫.png")?.body).toBe("PNGDATA");
    expect(bucket.store.has("f/default/会话/s-1/draw-1-a.png")).toBe(false);
  });

  it("文件夹整体搬：前缀下所有对象都跟过去，旧的删干净", async () => {
    const bucket = memBucket();
    await bucket.put("f/default/旧夹/a.txt", "A");
    await bucket.put("f/default/旧夹/子/b.txt", "B");
    const out = await filesOf(ctxOf(bucket)).execute({
      action: "move",
      key: "f/default/旧夹",
      to: "f/default/新夹",
    });
    expect(out).toContain("2 个文件");
    expect(bucket.store.get("f/default/新夹/a.txt")?.body).toBe("A");
    expect(bucket.store.get("f/default/新夹/子/b.txt")?.body).toBe("B");
    expect([...bucket.store.keys()].filter((k) => k.includes("旧夹"))).toEqual(
      [],
    );
  });

  it("搬进自己的子目录拒绝：那会把刚搬的副本又搬一遍", async () => {
    const bucket = memBucket();
    await bucket.put("f/default/夹/a.txt", "A");
    const out = await filesOf(ctxOf(bucket)).execute({
      action: "move",
      key: "f/default/夹",
      to: "f/default/夹/里",
    });
    expect(out).toContain("自己里面");
    expect(bucket.store.get("f/default/夹/a.txt")?.body).toBe("A");
  });

  it("原地不动不搬；不存在的来源如实回话", async () => {
    const bucket = memBucket();
    await filesOf(ctxOf(bucket)).execute({
      action: "move",
      key: "f/default/x.png",
      to: "f/default/x.png",
    });
    const out = await filesOf(ctxOf(bucket)).execute({
      action: "move",
      key: "f/default/没有.png",
      to: "f/default/去处.png",
    });
    expect(out).toContain("没有这个文件或文件夹");
    expect(bucket.store.size).toBe(0);
  });
});
