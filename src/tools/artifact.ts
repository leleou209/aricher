// artifact：现场生成的交互式卡片。
//
// 一张清单、一份对比表、一个小仪表盘 —— 有时候一张能点的卡片比一千字更顶用。
// ericher 把一份自包含的 HTML（样式、脚本全部内联，不引用任何外部资源）
// 存进云盘，回复里用一行 [artifact <key> <标题>] 引用，前端就把这行
// 渲染成对话里直接可以玩的 iframe 卡片。
//
// 安全模型：HTML 是模型写的，前端一律用 sandbox iframe（脚本可跑、无同源权限）
// 渲染，后端给 text/html 响应垫 Content-Security-Policy: sandbox ——
// 就算有人把卡片链接单独开个窗口，那也是不透明源，碰不到登录者的任何东西。

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { scopedKey } from "../fileAccess";
import type { ToolCtx } from "./types";

/** 卡片体积上限：一张卡片不该是一本书，200KB 足够任何合理的交互页面 */
const MAX_HTML = 200_000;

export function artifactTools(ctx: ToolCtx) {
  return {
    artifact: tool({
      description:
        "生成一张可交互的 HTML 卡片（对比表、清单、日程、小仪表盘、步骤图这类），" +
        "存好后内联展示在对话里。" +
        "HTML 必须完全自包含：<style> 和 <script> 全部内联，不引用任何外部资源" +
        "（外链图片/CSS/字体都不行），浅色纸面风格，宽度自适应（手机也要能看）。" +
        "存成功后，在回复里另起一行写 [artifact <返回的key> <标题>]，那行会变成卡片。",
      inputSchema: z.object({
        title: z.string().max(40).describe("卡片标题，比如「两份 offer 对比」"),
        html: z
          .string()
          .max(MAX_HTML)
          .describe("完整的 HTML 文档（<!doctype html> 开头，自包含）"),
      }),
      execute: async ({ title, html }) => {
        const bucket = ctx.env.MEMORY_BUCKET;
        if (!bucket) return "云盘未配置，卡片存不了。";
        const key = scopedKey(ctx.room, "artifact", "html");
        await bucket.put(key, html, {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
        });
        return (
          `卡片已存好（key: ${key}）。` +
          `在回复里另起一行写：[artifact ${key} ${title}] —— ` +
          `那一行会渲染成对话里的内联卡片。`
        );
      },
    }),
  };
}
