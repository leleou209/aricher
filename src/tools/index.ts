// 工具集合入口。所有工具都是原生 AI SDK tool（有 inputSchema + execute），
// 不再有 [TOOL:xxx] 正则解析。

import type { ToolSet } from "ai";
import { adminTools } from "./admin";
import { artifactTools } from "./artifact";
import { askTools } from "./ask";
import { drawTools } from "./draw";
import { feedbackTools } from "./feedback";
import { fileTools } from "./files";
import { memoryTools, guestMemoryTools } from "./memory";
import { noteTools } from "./note";
import { recallTools } from "./recall";
import { remindTools } from "./remind";
import { searchTools } from "./search";
import { sessionTools } from "./session";
import { sessionMemoTools } from "./sessionMemo";
import { taskTools } from "./task";
import type { ToolCtx } from "./types";
import { visionTools } from "./vision";
import { visitorLogTools } from "./visitor";
import { weatherTools } from "./weather";

export type { ToolCtx } from "./types";

export function buildTools(ctx: ToolCtx): ToolSet {
  // 多档来客类型：三个 perm 开关决定来客那间注册哪些对外工具组。
  // 只对来客生效，主人那间不受影响；没带 guestType（普通来客票、老 state）
  // 一律视为全开 —— 开关是「明确关掉才生效」的语义，缺省不能反着解释成全关。
  const gt = ctx.guestType;
  // 天气/识图不设开关（它们不出去网、也不留东西），检索/画画/记忆各自跟着档位走
  const outward: ToolSet = {
    ...(ctx.guest && gt?.permSearch === false ? {} : searchTools(ctx)),
    ...weatherTools(),
    ...visionTools(ctx),
    ...(ctx.guest && gt?.permDraw === false ? {} : drawTools(ctx)),
    // 卡片对两间都开：给来客出清单/对比表正是接待的活，管理员自己也用得上。
    // 安全靠渲染端的 sandbox iframe + 响应头 CSP，不靠「不给工具」
    ...artifactTools(ctx),
  };
  // 来客到此为止：管理员自己的记忆、任务、提醒、文件都不给他碰 ——
  // 给了他既等于泄露，也等于让他替管理员做决定。
  // 唯一的例外是记忆，而且是「受限读」的那一半：
  // 他说的关于他自己的事值得被记下（管理员那边也留一份）；
  // 翻得到的是管理员公开过的 + 他自己名下的（按称呼过滤，在 SQL 里完成），
  // private 的主体一个字都不出管理员那间屋。
  // visitor_log 也只在这间有，且不设开关：留痕是明说的，客人随时能翻自己的账。
  if (ctx.guest)
    return {
      ...outward,
      ...(gt?.permMemory === false ? {} : guestMemoryTools(ctx)),
      ...visitorLogTools(ctx),
    };

  return {
    ...outward,
    ...fileTools(ctx),
    // 回头问他一句。只给主人这一间：来客那间没有「正在替他做的事」，
    // 也就没有需要中途确认的岔口 —— 给了它，只会变成多问一句废话
    ...askTools(ctx),
    // 另开一场把一件事说清楚。跟 ask 同理：来客那间没有「我在替他做的事」，
    // 也就没有值得单独立一场的东西
    ...sessionTools(ctx),
    ...memoryTools(ctx),
    // 会话记录只给他这一间：来客那几场没有「她自己回头看」这回事，
    // 而且这条路写进去的东西会挂在会话上
    ...sessionMemoTools(ctx),
    ...recallTools(ctx),
    ...taskTools(ctx),
    // 笔记本只给他这一间：本子上是他自己的草稿，来客那间连「有这本子」都不该知道
    ...noteTools(ctx),
    ...remindTools(ctx),
    ...adminTools(ctx),
    ...feedbackTools(ctx),
  };
}

/** 工具名列表，用于统计与调试 */
export function toolNames(ctx: ToolCtx): string[] {
  return Object.keys(buildTools(ctx));
}
