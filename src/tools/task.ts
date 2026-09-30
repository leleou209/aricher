// 任务清单与技能配方。

import { tool } from "ai";
import { z } from "zod";
import type { Task } from "../agent/state";
import type { ToolCtx } from "./types";

const ICONS: Record<string, string> = { todo: "📋", doing: "🔄", done: "✅" };

export function taskTools(ctx: ToolCtx) {
  return {
    task: tool({
      description:
        "待办任务管理。list 列出全部；add 新建；update 改状态（索引从 0 开始）；delete 删除。",
      inputSchema: z
        .object({
          action: z.enum(["list", "add", "update", "delete"]),
          title: z.string().optional().describe("add 时的任务标题"),
          desc: z.string().optional().describe("add 时的补充说明"),
          index: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("update / delete 时的索引"),
          status: z
            .enum(["todo", "doing", "done"])
            .optional()
            .describe("update 时的新状态"),
        })
        .superRefine((a, refine) => {
          // action 的条件必填在 schema 层就拦下，别让缺参数的调用混进统计
          if (a.action === "add" && !(a.title || "").trim())
            refine.addIssue({
              code: "custom",
              path: ["title"],
              message: "add 必填：任务标题",
            });
          if (
            (a.action === "update" || a.action === "delete") &&
            a.index == null
          )
            refine.addIssue({
              code: "custom",
              path: ["index"],
              message: "update/delete 必填：任务索引（先 list 看，从 0 开始）",
            });
          if (a.action === "update" && !a.status)
            refine.addIssue({
              code: "custom",
              path: ["status"],
              message: "update 必填：新状态（todo/doing/done）",
            });
        }),
      execute: async (a) => {
        const tasks = [...ctx.state.tasks];

        if (a.action === "list") {
          if (!tasks.length) return "任务列表为空。";
          return tasks
            .map(
              (t, i) =>
                `[${i}] ${ICONS[t.status]} ${t.title}（${t.status}）${t.created}\n    ${t.desc}`,
            )
            .join("\n\n");
        }

        if (a.action === "add") {
          const title = (a.title || "").trim();
          if (!title) return "add 需要提供 title。";
          const task: Task = {
            title,
            desc: (a.desc || "").trim(),
            status: "todo",
            created: new Date().toISOString().slice(0, 10),
          };
          const next = [...tasks, task].slice(-50);
          ctx.patchState({ tasks: next });
          return `任务已创建 [${next.length - 1}] ${title}`;
        }

        if (a.index == null || a.index >= tasks.length) {
          return `索引无效，当前共 ${tasks.length} 条（0-${Math.max(0, tasks.length - 1)}）。`;
        }

        if (a.action === "update") {
          if (!a.status) return "update 需要提供 status。";
          tasks[a.index] = { ...tasks[a.index], status: a.status };
          ctx.patchState({ tasks });
          return `[${a.index}] ${tasks[a.index].title} → ${a.status}`;
        }

        const [removed] = tasks.splice(a.index, 1);
        ctx.patchState({ tasks });
        return `已删除 [${a.index}] ${removed.title}`;
      },
    }),

    skill: tool({
      description:
        "技能配方管理。技能是一串预先写好的步骤说明，run 会把步骤交回给你，由你用真实工具去执行。" +
        "适合反复要做的固定流程（比如「读一本书的笔记」）。",
      inputSchema: z.object({
        action: z.enum(["list", "save", "delete", "run"]),
        name: z.string().optional().describe("技能名"),
        steps: z
          .array(z.string())
          .optional()
          .describe("save 时的步骤列表，每步一句自然语言"),
      }),
      execute: async (a) => {
        const skills = { ...ctx.state.skills };

        if (a.action === "list") {
          const names = Object.keys(skills);
          if (!names.length) return "暂无自定义技能。";
          return names
            .map(
              (n) =>
                `• ${n}（${skills[n].length} 步）：${skills[n].join(" → ")}`,
            )
            .join("\n");
        }

        if (!a.name) return `${a.action} 需要提供 name。`;

        if (a.action === "save") {
          if (!a.steps?.length) return "save 需要提供至少一个步骤。";
          const existed = !!skills[a.name];
          skills[a.name] = a.steps;
          ctx.patchState({ skills });
          ctx.notify("技能已更新：" + a.name);
          return `${existed ? "已更新" : "已创建"}技能「${a.name}」（${a.steps.length} 步）`;
        }

        if (a.action === "delete") {
          if (!skills[a.name]) return "技能不存在：" + a.name;
          delete skills[a.name];
          ctx.patchState({ skills });
          ctx.notify("技能已删除：" + a.name);
          return "已删除技能：" + a.name;
        }

        const steps = skills[a.name];
        if (!steps) return `技能不存在：${a.name}（可用 skill list 查看）`;
        return (
          `📦 按技能「${a.name}」的步骤执行，请用你的真实工具逐步完成：\n` +
          steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
        );
      },
    }),
  };
}
