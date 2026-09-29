// 来客留痕工具：把行为档案当面摊开。
//
// 守则里承诺「我做的事留痕，而且明说」——光存在表里不算明说，
// 得让客人一句话就能翻到自己的账。所以这个工具只在来客那间有：
// 他问「你们记了我什么」时，ericher 用它把这一间的留痕原样读出来。
// 查不到别人的房间（这里根本没有别的房间），主人那边的管理面板另走一条路。

import { tool } from "ai";
import { z } from "zod";
import { listVisitorEvents } from "../agent/visitor";
import type { ToolCtx } from "./types";

const KIND_LABEL: Record<string, string> = {
  join: "进门",
  message: "留言",
  intro: "自我介绍",
  panel: "面板操作",
};

export function visitorLogTools(ctx: ToolCtx) {
  return {
    visitor_log: tool({
      description:
        "查看这位来访者在这间屋子里留下的行为记录（进门、留言、面板操作）。" +
        "客人问「你们记了我什么」「我的留痕」时用它，原样念给他听——留痕是明说的，不藏着。",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = listVisitorEvents(ctx.sql, ctx.room, 100);
        if (!rows.length) return "还没有任何留痕记录。";
        const lines = rows.map(
          (r) =>
            `${r.ts.slice(0, 19).replace("T", " ")} · ${KIND_LABEL[r.kind] || r.kind}` +
            (r.detail ? ` · ${r.detail}` : ""),
        );
        return `这位来访者在本间的留痕（新的在前，共 ${rows.length} 条）：\n${lines.join("\n")}`;
      },
    }),
  };
}
