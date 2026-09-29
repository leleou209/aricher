/**
 * 来客记忆登记的权益核实测试。
 *
 * addGuestEntry 的权限闸原来只认 WS 连接时留下的类型快照 —— 纯 HTTP 直呼
 * （POST /api/memory、进门介绍）不经过 onConnect，快照是空的，整段检查被
 * 跳过，权益就 fail-open 了。修法是「票据的 type 段由 Worker 带过来，
 * 两处都拿不到就拒绝」。
 *
 * addGuestEntry 是 DO 方法，这里用 prototype.call 顶着假 this 把它跑起来，
 * 盯的只有一个闸：类型从哪来、查不到怎么办。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect, vi } from "vitest";
import { CoworkAgent } from "../src/agent/cowork";
import type { SqlTag } from "../src/agent/state";

// 这两个包的底层拖着 cloudflare: 协议模块，vitest 的 ESM loader 加载不了。
// addGuestEntry 只用我们假 this 上的家当，不碰基类 —— 空壳替掉就行
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("agents", () => ({ getCurrentAgent: () => ({ agent: undefined }) }));

function makeDb() {
  const rows: Record<string, unknown>[] = [];
  const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    if (q.startsWith("CREATE")) return [] as never;
    // ensureMemorySchema 里的 ALTER 全被生产代码的 try/catch 包着：
    // 假库在这里抛错，正好像「列已存在」一样被吞掉
    if (q.startsWith("ALTER TABLE")) return [] as never;
    if (q.startsWith("INSERT OR REPLACE INTO memories")) {
      const cols = q
        .match(/INSERT OR REPLACE INTO memories \(([^)]*)\)/)![1]
        .split(",")
        .map((s) => s.trim());
      const rec: Record<string, unknown> = {};
      cols.forEach((c, i) => (rec[c] = vals[i]));
      rows.push(rec);
      return [] as never;
    }
    if (q.startsWith("SELECT * FROM memories WHERE dedupe_key"))
      return [] as never;
    throw new Error("假库不认得这条语句：" + q);
  }) as unknown as SqlTag;
  return { tag, rows };
}

const guestTypeInfo = (permMemory: boolean) => ({
  id: "t1",
  name: "测试档",
  note: "",
  permSearch: true,
  permDraw: true,
  permMemory,
  permNotes: true,
  permFiles: true,
  permPublic: true,
});

function harness(over: {
  guestTypeId?: string;
  ownerTypeInfo?: ReturnType<typeof guestTypeInfo> | null;
}) {
  const vectors: unknown[] = [];
  const db = makeDb();
  const env = {
    COWORK_AGENT: {
      idFromName: () => "owner",
      get: () => ({
        getTypeInfo: async () => over.ownerTypeInfo ?? null,
      }),
    },
  };
  // currentGuestType 用原型上的真实现：common 的本地全开快照、主人房 RPC、
  // 查不到回落 disabled 三条路都走真代码，测试才不算自己证自己
  const proto = CoworkAgent.prototype as unknown as Record<
    string,
    (this: Record<string, unknown>, ...args: never[]) => unknown
  >;
  let selfRef: Record<string, unknown>;
  const self = {
    isOwnerRoom: false,
    state: { guestTypeId: over.guestTypeId ?? "", guestName: "小张" },
    db: db.tag,
    name: "guest-room-a",
    env,
    enqueueVector: (v: unknown) => vectors.push(v),
    currentGuestType: (typeId: string) =>
      (
        proto.currentGuestType as unknown as (
          this: Record<string, unknown>,
          typeId: string,
        ) => Promise<unknown>
      ).call(selfRef, typeId),
  };
  selfRef = self;
  const call = (input: Record<string, unknown>) =>
    (
      CoworkAgent.prototype as unknown as {
        addGuestEntry: (input: Record<string, unknown>) => Promise<unknown>;
      }
    ).addGuestEntry.call(self, input);
  return { db, vectors, call };
}

describe("addGuestEntry：权益核实不 fail-open", () => {
  it("WS 快照是空的、票据也没带 type → 拒绝 —— 无法核实就没有权益", async () => {
    const { db, vectors, call } = harness({});
    const r = await call({ content: "HTTP 直呼的一笔" });
    expect(r).toBeNull();
    expect(db.rows).toHaveLength(0);
    expect(vectors).toHaveLength(0);
  });

  it("票据带 type=common（通用来客档）→ 本地全开快照放行，照常落库", async () => {
    const { db, vectors, call } = harness({});
    const r = (await call({
      content: "门禁码来客的一笔",
      typeId: "common",
    })) as { id: string } | null;
    expect(r).not.toBeNull();
    expect(db.rows).toHaveLength(1);
    expect(vectors).toHaveLength(1);
  });

  it("名册里这一档把记忆登记关了 → 拒绝 —— 票据有 type 也过不去", async () => {
    const { db, vectors, call } = harness({
      ownerTypeInfo: guestTypeInfo(false),
    });
    const r = await call({ content: "被关权益的一笔", typeId: "t1" });
    expect(r).toBeNull();
    expect(db.rows).toHaveLength(0);
    expect(vectors).toHaveLength(0);
  });

  it("WS 快照里已有类型（原有路径）不带 type 也照常放行", async () => {
    const { db, call } = harness({ guestTypeId: "common" });
    const r = await call({ content: "连过 WS 的来客写的一笔" });
    expect(r).not.toBeNull();
    expect(db.rows).toHaveLength(1);
  });
});
