// ─────────────────────────────────────────────────────────────
// hr-desk · 面板公共件 —— 常量与纯工具函数
//
// 面板组件拆在 Panels.tsx（前半）与 Panels2.tsx（后半）两个文件里。
// 这个文件只放两边都要用的常量与纯计算，不放任何 React 组件 ——
// 依赖方向永远是 Panels→PanelsShared、Panels2→PanelsShared，
// 两个组件文件互不认识，循环依赖就无从谈起。
// ─────────────────────────────────────────────────────────────

import type { IconName } from "./Icons";
import type { ChatState, MemEntry } from "../lib/types";

/** 面板改全局状态的统一姿势：交一小块补丁给上层去落库 */
export type Patch = (patch: Partial<ChatState>) => Promise<void>;

/** 工具的中文名片：消息里的工具调用从这里取。 */
export const TOOL_META: Record<
  string,
  { zh: string; desc: string; icon: IconName }
> = {
  search: {
    zh: "联网搜索",
    desc: "搜实时信息，先看结果再决定读哪条",
    icon: "search",
  },
  read_url: {
    zh: "读网页",
    desc: "抓取网页正文，提炼成可用的材料",
    icon: "link",
  },
  browse: {
    zh: "微浏览器",
    desc: "打开页面，看正文也看它能点去哪",
    icon: "maximize",
  },
  weather: { zh: "天气", desc: "查询任意城市的实时天气", icon: "compass" },
  call_tool: {
    zh: "工具网关",
    desc: "按需调用渐进式清单里的工具",
    icon: "maximize",
  },
  files: { zh: "云盘文件", desc: "读写云盘上的文件", icon: "clipboard" },
  view_image: {
    zh: "看图",
    desc: "把云盘里的图调出来自己看",
    icon: "image",
  },
  draw: { zh: "画图", desc: "把一段描述画成一张图", icon: "edit" },
  diagram: {
    zh: "画示意图",
    desc: "用 mermaid 画流程图、架构图、时序图",
    icon: "layers",
  },
  send_image: { zh: "发图", desc: "把云盘里存过的图发到对话里", icon: "image" },
  memory: {
    zh: "记忆库",
    desc: "长期记忆的增删查、复核与人脉视图",
    icon: "book-open",
  },
  recall: {
    zh: "搜旧会话",
    desc: "去以前的会话里，找回当时的原话",
    icon: "clock",
  },
  session_memo: {
    zh: "会话提要",
    desc: "没人说话时，我自己回头写下的这一场提要",
    icon: "book-open",
  },
  note: {
    zh: "笔记本",
    desc: "他的原稿成篇记下，不是我的转述",
    icon: "edit",
  },
  artifact: {
    zh: "交互卡片",
    desc: "出一张沙箱里渲染的 HTML 卡片",
    icon: "layers",
  },
  visitor_log: {
    zh: "留痕",
    desc: "来客在这间屋子的进门、留言与面板操作",
    icon: "user",
  },
  task: { zh: "任务清单", desc: "记下待办，并推进状态", icon: "check" },
  remind: { zh: "提醒", desc: "定个时间，到点我自己来开口", icon: "bell" },
  skill: { zh: "技能配方", desc: "把多步流程存成可复用的配方", icon: "layers" },
  self: { zh: "自我认知", desc: "反思并更新对自己的理解", icon: "compass" },
  stats: { zh: "记忆统计", desc: "看各分类现在有多少条", icon: "maximize" },
  organize: { zh: "整理对话", desc: "萃取长期记忆与会话摘要", icon: "refresh" },
  set_think_mode: {
    zh: "思考模式",
    desc: "在普通与深度之间切换",
    icon: "type",
  },
  feedback: { zh: "读反馈", desc: "看你对我回答的赞踩与评论", icon: "comment" },
  ask: {
    zh: "回头问你",
    desc: "卡在只有你能定的岔口上，问一句等你答",
    icon: "help-circle",
  },
  openSession: {
    zh: "另开一场",
    desc: "把一件事单独立成一场说清楚，你得空再看",
    icon: "plus",
  },
};

export const TOOL_FALLBACK = {
  zh: "原生工具",
  desc: "ericher 可以直接调用的能力",
  icon: "settings" as IconName,
};

export const toolMeta = (name: string) =>
  TOOL_META[name] || { ...TOOL_FALLBACK, zh: name };

/**
 * 「学到多久了」的人话版本。和 src/agent/memory.ts 的 ageLabel 是同一套说法，
 * 前端手写镜像（跨 node/web 边界不能直接 import）。
 */
export function ageText(iso: string, fallbackDate = ""): string {
  const t = new Date(iso || fallbackDate || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return "时间不明";
  const days = Math.max(0, (Date.now() - t) / 86400000);
  if (days < 1) return "今天";
  if (days < 2) return "昨天";
  if (days < 30) return `${Math.floor(days)} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** 会变的记忆隔多久没复核就该提醒一次。和后端 memory.ts 的 REVIEW_DAYS 是同一个数。 */
const REVIEW_DAYS = 30;

/** 该复核了：会变 + 还算数 + 距上次确认超过 REVIEW_DAYS。前端只为显示标记，判定在后端。 */
export function needReview(m: MemEntry): boolean {
  if (m.volatility !== "volatile" || m.supersededBy) return false;
  const t = new Date(m.verified || m.learned || m.date || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return true;
  return Date.now() - t > REVIEW_DAYS * 86400000;
}

/** 时刻的短格式：月日 + 时分。提醒面板和来客留痕共用 —— 读两眼就能对上「是不是刚才」。 */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 设备身份：第一次来发一个随机代号，存进 localStorage，以后都认它。
 * 不挂账号、不追设备指纹 —— 就是个「这台机器」的记号。
 */
export function deviceId(): string {
  const KEY = "xm_device";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = "d" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(KEY, id);
  }
  return id;
}
