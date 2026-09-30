// R2 记忆库文件操作。破坏性操作要求显式 confirm，clear 必须给前缀。
//
// 房间划界：桶是同一只，屋子是分开的。来客那间调用本工具时，list/read/delete/clear
// 一律限定在自己房间前缀（f/<room>/…）下 —— 否则一个「列目录」就把全库文件名翻出来，
// 一个 delete 就能删掉别家的东西。管理员那间不设限（管理员本来就全库可见）。
//
// 文件夹是纯约定：key 里的路径段就是目录（会话/<id>/ 是产物自动归档处）。
// mkdir 塞一个 .keep 占位对象把空夹撑住；move 是「复制到新 key、删掉旧 key」，
// 精确命中一个对象就搬一个，没命中就当前缀把整个文件夹搬过去 ——
// 所以「改名」不用单独一条工具：move 到同目录换个文件名就是。

import { tool } from "ai";
import { z } from "zod";
import { FOLDER_KEEP, roomKeyPrefix, safeKeyPath } from "../fileAccess";
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
        "delete 删除单个文件（需 confirm=true）；clear 按前缀批量删除（需 confirm=true，且必须提供 prefix）；" +
        "mkdir 新建文件夹（path 可以多级，如 f/default/个人/合同）；" +
        "move 移动或重命名（from = 现在的 key，to = 完整去处 key；改名 = 同目录换文件名，" +
        "from 是文件夹前缀时整夹搬）。",
      inputSchema: z
        .object({
          action: z.enum(["list", "read", "delete", "clear", "mkdir", "move"]),
          key: z
            .string()
            .optional()
            .describe("文件名，read / delete 时必填；move 时是「从哪搬」"),
          prefix: z
            .string()
            .optional()
            .describe("clear 时必填，只删除以此为前缀的文件"),
          path: z
            .string()
            .optional()
            .describe("mkdir 时必填：要建的文件夹路径，可以一次建几级"),
          to: z
            .string()
            .optional()
            .describe("move 时必填：完整的去处 key（含文件名）"),
          confirm: z
            .boolean()
            .default(false)
            .describe("破坏性操作必须显式置 true"),
        })
        .superRefine((a, refine) => {
          // action 的条件必填在 schema 层就拦下：错误信息里曾经写错字段名（from/key），
          // 模型照着错误重试永远失败 —— 现在校验直接说清缺什么
          const needKey =
            a.action === "read" || a.action === "delete" || a.action === "move";
          if (needKey && !(a.key || "").trim())
            refine.addIssue({
              code: "custom",
              path: ["key"],
              message: `${a.action} 必填：文件 key（list 里能看到）`,
            });
          if (a.action === "move" && !(a.to || "").trim())
            refine.addIssue({
              code: "custom",
              path: ["to"],
              message: "move 必填：完整的去处 key（含文件名）",
            });
          if (a.action === "clear" && !(a.prefix || "").trim())
            refine.addIssue({
              code: "custom",
              path: ["prefix"],
              message: "clear 必填：要清空的前缀",
            });
          if (a.action === "mkdir" && !(a.path || "").trim())
            refine.addIssue({
              code: "custom",
              path: ["path"],
              message: "mkdir 必填：文件夹路径，可以多级",
            });
        }),
      execute: async ({ action, key, prefix, path, to, confirm }) => {
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

        if (action === "mkdir") {
          if (!path) return "mkdir 需要提供 path（文件夹路径）。";
          let base: string;
          try {
            base = safeKeyPath(path);
          } catch (e) {
            return `这个路径用不了：${(e as Error).message}`;
          }
          if (!inScope(base))
            return "这个路径超出了本间的文件范围，建夹只能建在自己那间。";
          await bucket.put(`${base}/${FOLDER_KEEP}`, "", {
            httpMetadata: { contentType: "application/x-empty" },
          });
          return `文件夹建好了：${base}/（之后往里放文件就用这个前缀）。`;
        }

        if (action === "move") {
          if (!key || !to)
            return "move 需要提供 key（现在在哪）和 to（完整去处 key）。";
          let src = "";
          let dst = "";
          try {
            src = safeKeyPath(key);
            dst = safeKeyPath(to);
          } catch (e) {
            return `这个路径用不了：${(e as Error).message}`;
          }
          if (!inScope(src) || !inScope(dst))
            return "搬进或搬出的路径超出了本间的文件范围，只能动自己那间的。";
          if (src === dst) return "原地不动，不用搬。";
          if (dst.startsWith(`${src}/`))
            return "不能把文件夹搬进它自己里面 —— 换个去处。";
          // 精确命中一个对象：就是移动 / 改名一个文件
          const obj = await bucket.get(src);
          if (obj) {
            await bucket.put(dst, obj.body, {
              httpMetadata: obj.httpMetadata,
            });
            await bucket.delete(src);
            return `搬好了：${src} → ${dst}`;
          }
          // 没精确命中就当前缀：整个「文件夹」逐个 copy + delete
          const srcPrefix = `${src}/`;
          let moved = 0;
          let cursor: string | undefined;
          do {
            const list = await bucket.list({
              prefix: srcPrefix,
              cursor,
              limit: 500,
            });
            for (const o of list.objects) {
              const one = await bucket.get(o.key);
              if (!one) continue;
              await bucket.put(
                `${dst}/${o.key.slice(srcPrefix.length)}`,
                one.body,
                {
                  httpMetadata: one.httpMetadata,
                },
              );
              await bucket.delete(o.key);
              moved++;
            }
            cursor = list.truncated ? list.cursor : undefined;
          } while (cursor);
          return moved
            ? `整个文件夹搬好了（${moved} 个文件）：${src}/ → ${dst}/`
            : `没有这个文件或文件夹：${src}`;
        }

        if (action === "delete") {
          if (!key) return "delete 需要提供 key。";
          if (!inScope(key)) return "文件不存在：" + key;
          // R2 删一个不存在的 key 也算成功：不先看一眼，就会回「已删除」一个
          // 本来就没有的东西 —— 同楼的 move / read 都先验存在，这条照做
          if (!(await bucket.head(key))) return "没有这个文件：" + key;
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
