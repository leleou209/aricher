// 工具分层的契约钉子。
//
// 渐进式披露最大的隐患是「静默失踪」：新加一个工具忘了归类，
// 它既不常驻也不在索引里，模型根本不知道它存在——而且不报错，只是永远用不上。
// 这组用例把三件事钉死：
//   1. 常驻 ∪ 渐进式 = 主人间的全部工具（少一个名字，测试当场炸）；
//   2. 渐进式的 schema 真的不进请求、call_tool 真的进；
//   3. 转正名单里的名字真的出现在栈里（下架的旧名字被滤掉）。
import { describe, expect, it } from "vitest";
import {
  DEFERRED_TOOLS,
  PROMOTE_CAP,
  RESIDENT_TOOLS,
  buildToolStack,
  buildTools,
} from "../src/tools/index";
import { toolGuide } from "../src/agent/prompt";
import { OWNER_TOOL_NAMES } from "../src/agent/toolGroups";
import type { ToolCtx } from "../src/tools/types";

const boom = () => {
  throw new Error("build 期不该调用 ctx 方法");
};

function mockCtx(guest = false): ToolCtx {
  return {
    env: {},
    sql: boom,
    room: guest ? "guest-ab12" : "default",
    guest,
    state: {},
    patchState: boom,
    notify: boom,
    enqueueVector: boom,
    maintenance: boom,
    drawTiers: boom,
    searchConfig: boom,
    organize: boom,
    transcript: boom,
    recentMessages: boom,
    scheduleReminder: boom,
    openSession: boom,
    listReminders: boom,
    cancelReminder: boom,
    recall: boom,
    listNotes: boom,
    readNote: boom,
    saveNote: boom,
    deleteNote: boom,
    focusedNote: boom,
  } as unknown as ToolCtx;
}

function keysOf(set: unknown): string[] {
  return Object.keys(set as Record<string, unknown>).sort();
}

describe("工具分层契约", () => {
  it("常驻 ∪ 渐进式 = 主人间的全部工具，不多不少", () => {
    const all = keysOf(buildTools(mockCtx()));
    const covered = [...RESIDENT_TOOLS, ...DEFERRED_TOOLS].sort();
    expect(covered).toEqual(all);
    // 两个名单不许重叠：重叠的名字会既常驻又被索引提一遍
    const overlap = RESIDENT_TOOLS.filter((n) =>
      (DEFERRED_TOOLS as readonly string[]).includes(n),
    );
    expect(overlap).toEqual([]);
  });

  it("渐进式的 schema 不进请求，call_tool 进", () => {
    const stack = keysOf(buildToolStack(mockCtx()));
    expect(stack).toEqual([...RESIDENT_TOOLS, "call_tool"].sort());
  });

  it("转正名单里的工具出现在栈里；名单里的旧名字（已下架）被滤掉", () => {
    const stack = buildToolStack(mockCtx(), {
      promoted: ["memory", "ghost-tool"],
    });
    const keys = keysOf(stack);
    expect(keys).toContain("memory");
    expect(keys).not.toContain("ghost-tool");
    // 转正了就不在渐进式名单里：网关对它已经是「索引里没有」
    const call = (stack as Record<string, never>)["call_tool"] as unknown as {
      execute: (a: unknown) => Promise<string>;
    };
    // 不用真调 execute——直接验证它进了常驻、DEFERRED 里还留着 memory 也无妨，
    // 网关侧的过滤由 buildToolStack 的 deferred 收集保证，这里只钉栈的形状
    expect(keys).toContain("call_tool");
  });

  it("来客那间不拆层：全量工具、没有 call_tool", () => {
    const all = keysOf(buildTools(mockCtx(true)));
    const stack = keysOf(buildToolStack(mockCtx(true)));
    expect(stack).toEqual(all);
    expect(stack).not.toContain("call_tool");
  });

  it(`转正上限 ${PROMOTE_CAP}：超出的名字不进栈`, () => {
    const over = [...DEFERRED_TOOLS, "ghost"].slice(0, PROMOTE_CAP + 3);
    const stack = buildToolStack(mockCtx(), { promoted: over });
    const keys = keysOf(stack);
    const promotedIn = keys.filter(
      (n) =>
        (DEFERRED_TOOLS as readonly string[]).includes(n) &&
        !(RESIDENT_TOOLS as readonly string[]).includes(n),
    );
    expect(promotedIn.length).toBeLessThanOrEqual(PROMOTE_CAP);
  });

  it("索引契约：主人间的名册与工具箱一一对齐，且每件都写进工具说明", () => {
    // 名册（toolGroups.ts 的 TOOLS）是唯一的一份，工具箱是代码长出来的 ——
    // 两边靠这条测试对齐。新工具进来忘了登记，模型就永远不知道它存在；这里当场炸。
    const all = keysOf(buildTools(mockCtx()));
    expect([...OWNER_TOOL_NAMES].sort()).toEqual(all);
    const guide = toolGuide({ guest: false });
    const missing = all.filter((n) => !guide.includes(n));
    expect(missing).toEqual([]);
  });
});
