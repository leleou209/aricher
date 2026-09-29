// 笔记本工具：我和管理员一起写的本子。
//
// 它和 memory 的分工必须说清（description 里也说），否则两件事会互相吞掉：
//   memory —— 我记住的东西。措辞是我定的，他读到的是我的转述。
//   note   —— 他要留下的东西。原话、成篇、Markdown 保结构，一篇一篇。
// 为什么非得有 note 这一格：他以前想让一件事「留着」，只能塞进记忆里 ——
// 而记忆是我消化过的产物。他要的是原稿，不是我的读书笔记。
//
// 分工的另一半：写下来归我（哪一篇该留、该怎么措辞，那是语义判断），
// 落库、压旧版、裁版本、查 id 归代码（见 noteStore.ts）。和承诺账本那套一致。

import { tool } from "ai";
import { z } from "zod";
import { NOTE_CAP, NOTE_BODY_MAX, describeNote } from "../agent/noteStore";
import type { ToolCtx } from "./types";

/** read 一次最多吐这么多字：整本倒给模型既烧钱又没意义，剩下的让他自己再翻一次 */
const READ_LIMIT = 8000;

export function noteTools(ctx: ToolCtx) {
  return {
    note: tool({
      description:
        "和用户共用的笔记本，一篇一篇的 Markdown。\n" +
        "它和 memory 不是一回事：memory 是「我记住的东西」（措辞是我定的，他读到的是我的转述）；" +
        "note 是「他要留下的东西」（他的原话、成篇、保结构）。" +
        "他让我把一件事写下来留着、或者让我整理他正在写的那一篇，我用 note，不用 memory。\n" +
        "list 看笔记本里有哪些篇（给 q 按词搜，给 tag 按标签筛）；" +
        "read 读全文（不给 id 就读他此刻正在看的那一篇）；" +
        "new 新建一篇；write 整体改写某一篇的正文（⚠️ 这是覆盖式的，他会看到的是我改完的版本）；" +
        "append 在一篇末尾追加一段（不想动他写过的字时走这条）；" +
        "tag 改标签（tags 是要加上的，untag 是要拿掉的）；delete 删掉一整篇。\n" +
        "我改过的字会记成「我改的」，他那边看得出来 —— 所以改完我在对话里说清我动了哪几处。\n" +
        "覆盖不是不可逆的：代码会替每一篇留最近几个旧版本，他一句「退回去」就能恢复。" +
        `笔记本上限 ${NOTE_CAP} 篇，单篇正文上限 ${NOTE_BODY_MAX} 字。`,
      inputSchema: z.object({
        action: z.enum([
          "list",
          "read",
          "new",
          "write",
          "append",
          "tag",
          "delete",
        ]),
        id: z
          .string()
          .optional()
          .describe(
            "read/write/append/tag/delete 用的笔记 id（list 里能看到）",
          ),
        title: z.string().optional().describe("new/write 选填：这一篇叫什么"),
        body: z
          .string()
          .optional()
          .describe("new/write 的正文（Markdown 原文）"),
        text: z
          .string()
          .optional()
          .describe("append 要追加的那一段（Markdown）"),
        tags: z
          .string()
          .optional()
          .describe("new/write/tag：要加上的标签，逗号分隔"),
        untag: z.string().optional().describe("tag：要拿掉的标签，逗号分隔"),
        q: z.string().optional().describe("list：按词搜（命中标题或正文）"),
        tag: z.string().optional().describe("list：按标签筛，精确命中"),
      }),
      execute: (a) => {
        // 标签在工具里是逗号串，到了 store 才是数组 —— 让模型少写一层 JSON 括号
        const split = (s?: string) =>
          (s || "")
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean);

        if (a.action === "list") {
          const rows = ctx.listNotes({ q: a.q, tag: a.tag });
          if (!rows.length) {
            const why = a.q || a.tag ? "没有对上的" : "本子还空着";
            return `${why}。要用 note 的 new 起一篇吗？`;
          }
          return (
            `本子上有 ${rows.length} 篇${a.q || a.tag ? "（筛过的）" : ""}：\n` +
            rows
              .map(
                (n) =>
                  `${describeNote(n)}${n.preview ? `\n    ${n.preview}` : ""}`,
              )
              .join("\n")
          );
        }

        if (a.action === "read") {
          const target = a.id ? ctx.readNote(a.id) : ctx.focusedNote();
          if (!target) {
            return a.id
              ? `没有 id 为 ${a.id} 的那一篇 —— 先用 list 看一眼。`
              : "他这会儿没打开哪一篇笔记。先用 list 挑一篇，或者问他在说哪篇。";
          }
          const cut =
            target.body.length > READ_LIMIT
              ? "\n\n…（后面还有，这一篇挺长）"
              : "";
          return (
            `《${target.title}》${target.tags.length ? `｜标签：${target.tags.join("、")}` : ""}` +
            `｜${target.updatedBy === "assistant" ? "上次我改的" : "上次他改的"}\n` +
            `id：${target.id}\n\n${target.body.slice(0, READ_LIMIT)}${cut}`
          );
        }

        if (a.action === "new") {
          const body = (a.body || "").trim();
          if (!body && !(a.title || "").trim())
            return "new 至少要给 title 或 body —— 空的一篇他自己也不知道是什么。";
          try {
            const n = ctx.saveNote({
              title: a.title,
              body,
              tags: split(a.tags),
            });
            return `起了新的一篇：《${n.title}》（id：${n.id}）。以后说「那篇讲什么的」我按标题找。`;
          } catch (e) {
            return (e as Error).message;
          }
        }

        if (
          a.action === "write" ||
          a.action === "append" ||
          a.action === "tag" ||
          a.action === "delete"
        ) {
          // 这四种都要落到某一篇上：不给 id 就往「他正在看的那一篇」上落 ——
          // 他指着屏幕说「这篇」，指的多半就是它
          const id = (a.id || "").trim() || (ctx.focusedNote()?.id ?? "");
          if (!id)
            return `${a.action} 需要 id，但他这会儿也没打开哪一篇 —— 先用 list 挑一篇。`;
          const old = ctx.readNote(id);
          if (!old) return `没有 id 为 ${id} 的那一篇 —— 先用 list 看一眼。`;

          if (a.action === "delete") {
            ctx.deleteNote(id);
            return `删掉了《${old.title}》一整篇（连它那几版旧稿）。`;
          }

          if (a.action === "tag") {
            const add = split(a.tags);
            const drop = split(a.untag);
            if (!add.length && !drop.length)
              return "tag 需要 tags（要加的）或者 untag（要拿掉的）。";
            const next = old.tags.filter((t) => !drop.includes(t));
            const merged = [...next, ...add.filter((t) => !next.includes(t))];
            const n = ctx.saveNote({ id, tags: merged });
            return `《${n.title}》的标签现在是：${n.tags.length ? n.tags.join("、") : "（没有标签）"}。`;
          }

          if (a.action === "append") {
            const text = (a.text || "").trim();
            if (!text) return "append 需要 text：要追加的那一段。";
            const n = ctx.saveNote({
              id,
              body: old.body ? `${old.body}\n\n${text}` : text,
            });
            return `在《${n.title}》末尾加了一段，这一篇现在 ${n.body.length} 字。他那边的正文会跟着更新。`;
          }

          const body = (a.body || "").trim();
          if (!body)
            return "write 需要 body：改写之后的完整正文（这一条是覆盖式的，不能只给要改的那一句）。";
          const n = ctx.saveNote({
            id,
            body,
            title: a.title,
            tags: a.tags ? split(a.tags) : undefined,
          });
          return (
            `改写好了《${n.title}》（${old.body.length} → ${n.body.length} 字）。` +
            "旧的那版我留着了，他要退回去随时可以 —— 但我在回复里得说清我动了哪几处。"
          );
        }

        return "没认出来这个动作。";
      },
    }),
  };
}
