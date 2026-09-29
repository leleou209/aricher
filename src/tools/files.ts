// R2 记忆库文件操作。破坏性操作要求显式 confirm，clear 必须给前缀。
//
// 房间划界：桶是同一只，屋子是分开的。来客那间调用本工具时，list/read/delete/clear
// 一律限定在自己房间前缀（f/<room>/…）下 —— 否则一个「列目录」就把全库文件名翻出来，
// 一个 delete 就能删掉别家的东西。管理员那间不设限（管理员本来就全库可见）。

import { tool } from "ai";
import { z } from "zod";
import { roomKeyPrefix } from "../fileAccess";
import type { ToolCtx } from "./types";

function fmtSize(n: number): string {
  if (n < 1024) return n + "B";
  if (n < 1048576) return (n / 1024).toFixed(1) + "KB";
  return (n / 1048576).toFixed(1) + "MB";
}

export function fileTools(ctx: ToolCtx) {
  return {
    files: tool({
      description:
        "记忆库文件（对象存储）操作。action=list 列目录；read 读文本内容；" +
        "delete 删除单个文件（需 confirm=true）；clear 按前缀批量删除（需 confirm=true，且必须提供 prefix）。",
      inputSchema: z.object({
        action: z.enum(["list", "read", "delete", "clear"]),
        key: z.string().optional().describe("文件名，read / delete 时必填"),
        prefix: z
          .string()
          .optional()
          .describe("clear 时必填，只删除以此为前缀的文件"),
        confirm: z
          .boolean()
          .default(false)
          .describe("破坏性操作必须显式置 true"),
      }),
      execute: async ({ action, key, prefix, confirm }) => {
        const bucket = ctx.env.MEMORY_BUCKET;
        if (!bucket) return "记忆库未配置。";
        // 来客那间的可见范围：自己房间的文件。老对象（没有房间前缀）不在范围内
        const scope = ctx.guest ? roomKeyPrefix(ctx.room) : "";
        const inScope = (k: string) => !scope || k.startsWith(scope);

        if (action === "list") {
          const list = await bucket.list({
            prefix: scope || undefined,
            limit: 200,
          });
          if (!list.objects.length) return "文件库是空的 📭";
          return (
            `📦 ${list.objects.length} 个文件：\n` +
            list.objects
              .map((o, i) => `${i + 1}. ${o.key} (${fmtSize(o.size)})`)
              .join("\n")
          );
        }

        if (action === "read") {
          if (!key) return "read 需要提供 key。";
          if (!inScope(key)) return "文件不存在：" + key;
          const obj = await bucket.get(key);
          if (!obj) return "文件不存在：" + key;
          const text = await obj.text();
          return `📄 ${key}\n\n${text.slice(0, 6000)}${text.length > 6000 ? "\n\n[已截断]" : ""}`;
        }

        if (action === "delete") {
          if (!key) return "delete 需要提供 key。";
          if (!inScope(key)) return "文件不存在：" + key;
          if (!confirm)
            return `删除是不可逆操作。确认要删除「${key}」的话，请带 confirm=true 再调用一次。`;
          await bucket.delete(key);
          return "已删除：" + key;
        }

        if (!prefix) return "clear 必须提供 prefix（避免误清整个桶）。";
        if (!inScope(prefix))
          return "这个前缀超出了本间的文件范围，clear 只能动自己那间的文件。";
        if (!confirm)
          return `clear 将删除所有以「${prefix}」开头的文件。确认请带 confirm=true 再调用一次。`;
        let deleted = 0;
        let cursor: string | undefined;
        do {
          const list = await bucket.list({ prefix, cursor, limit: 500 });
          for (const o of list.objects) {
            await bucket.delete(o.key);
            deleted++;
          }
          cursor = list.truncated ? list.cursor : undefined;
        } while (cursor);
        return `已按前缀「${prefix}」清空 ${deleted} 个文件。`;
      },
    }),
  };
}
