/**
 * 预备会话（草稿场）测试。
 *
 * 从前两处会随手往库里塞一行「新会话」：删掉当前会话时立刻补一行、
 * 空着手的台子一连上来先来一行。结果就是会话越删越多、列表里躺着一排
 * 从没人说过话的空场。修法是「预备栏」：state 里存指向，库里没有行，
 * 只有真的开口说了话（ensureRealSession）才转正落库。
 *
 * DO 方法用 prototype.call 顶着假 this 跑（同 guestEntry 测试的路子），
 * 假库只认 sessionStore 会发的那几条语句。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect, vi } from "vitest";
import type { UIMessage } from "ai";
import { CoworkAgent } from "../src/agent/cowork";
import type { SqlTag } from "../src/agent/state";

// 这两个包的底层拖着 cloudflare: 协议模块，vitest 的 ESM loader 加载不了。
// 这些方法只用假 this 上的家当，不碰基类 —— 空壳替掉就行
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("agents", () => ({ getCurrentAgent: () => ({ agent: undefined }) }));

/** 只认 sessions / session_messages 相关语句的假库 */
function makeDb() {
  const sessionRows = new Map<string, Record<string, unknown>>();
  const tag = (<T>(strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    if (q.startsWith("create table")) return [] as never;
    // ensureSessionSchema 里的 ALTER 全被 try/catch 包着：
    // 假库在这里抛错，正好像「列已存在」一样被吞掉
    if (q.startsWith("alter table")) throw new Error("列已存在");
    if (q.startsWith("insert into sessions")) {
      const cols = q
        .match(/insert into sessions \(([^)]*)\)/)![1]
        .split(",")
        .map((s) => s.trim());
      const rec: Record<string, unknown> = {};
      cols.forEach((c, i) => (rec[c] = vals[i]));
      sessionRows.set(rec.id as string, rec);
      return [] as never;
    }
    if (q.startsWith("delete from sessions where id")) {
      sessionRows.delete(vals[0] as string);
      return [] as never;
    }
    if (q.startsWith("delete from session_messages")) return [] as never;
    if (q.startsWith("update sessions")) return [] as never;
    if (q.startsWith("select count(*) as n from sessions"))
      return [{ n: sessionRows.size }] as never;
    if (q.startsWith("select s.id")) {
      const rows = [...sessionRows.values()].map((r) => ({
        id: r.id as string,
        n: 0,
        digest: "",
        archived: 0,
        named: 0,
        unread: 0,
        recap_upto: 0,
        recap_at: "",
        ...r,
      }));
      // getSession 带 where s.id = ?：假库也得照着过滤，不然查谁都是第一行
      const filtered =
        q.includes("where s.id =") && vals.length
          ? rows.filter((r) => r.id === vals[0])
          : rows;
      return filtered as never;
    }
    if (q.startsWith("select seq, message from session_messages"))
      return [] as never;
    if (q.startsWith("insert into session_messages")) return [] as never;
    throw new Error("假库不认得这条语句：" + q);
  }) as unknown as SqlTag;
  return { tag, sessionRows };
}

const userMsg = (text: string): UIMessage =>
  ({
    id: "m" + Math.random().toString(36).slice(2, 8),
    role: "user",
    parts: [{ type: "text", text }],
  }) as unknown as UIMessage;

function harness(
  opts: {
    activeSession?: string;
    messages?: UIMessage[];
  } = {},
) {
  const db = makeDb();
  // 假 this 挂在原型上：真实方法互相调用（createSession → ensureActiveSession →
  // snapshotSession）都走得到，只有家当（state / db / messages）是假的。
  // db / messages 在基类上是只有 getter 的属性，实例上用 defineProperty 遮蔽
  const self = Object.create(CoworkAgent.prototype) as Record<
    string,
    unknown
  > & { state: Record<string, unknown>; messages: UIMessage[] };
  Object.defineProperty(self, "db", { value: db.tag, configurable: true });
  Object.defineProperty(self, "messages", {
    value: opts.messages ?? [],
    writable: true,
    configurable: true,
  });
  Object.defineProperty(self, "state", {
    value: { activeSession: opts.activeSession ?? "" },
    writable: true,
    configurable: true,
  });
  self.patchState = (p: Record<string, unknown>) =>
    Object.assign(self.state, p);
  self.settleTurn = () => {};
  self.clearConversation = async () => {
    self.messages = [];
  };
  const call = <T>(method: string, ...args: unknown[]): T =>
    (
      CoworkAgent.prototype as unknown as Record<string, (...a: unknown[]) => T>
    )[method].apply(self, args) as T;
  return { db, self, call };
}

describe("预备会话：读路径不落库", () => {
  it("createSession 不点名 → 只立预备栏，库里的会话一行都不多", async () => {
    const { db, self, call } = harness({ activeSession: "s-old" });
    db.sessionRows.set("s-old", { id: "s-old", title: "旧场" });

    const r = await call<unknown>("createSession");
    expect(r).toBeNull();
    expect(db.sessionRows.size).toBe(1); // 旧场还在，没有新行
    expect((self.state as { activeSession: string }).activeSession).not.toBe(
      "s-old",
    );
    expect(
      db.sessionRows.has(
        (self.state as { activeSession: string }).activeSession,
      ),
    ).toBe(false); // 当前指向是预备栏，库里没有它
  });

  it("删掉当前会话 → 不再立刻生成一行「新会话」，指向换成新预备栏", async () => {
    const { db, self, call } = harness({ activeSession: "s-live" });
    db.sessionRows.set("s-live", { id: "s-live", title: "正在聊的" });

    const r = await call<{ removed: boolean; active: string }>(
      "deleteSession",
      "s-live",
    );
    expect(r.removed).toBe(true);
    expect(db.sessionRows.size).toBe(0); // 核心断言：删一场就是删一场
    expect(r.active).not.toBe("s-live");
    expect(db.sessionRows.has(r.active)).toBe(false); // active 是预备栏
    expect((self.state as { activeSession: string }).activeSession).toBe(
      r.active,
    );
  });

  it("删的不是当前会话 → 当前的原样保留，不多不少", async () => {
    const { db, call } = harness({ activeSession: "s-live" });
    db.sessionRows.set("s-live", { id: "s-live", title: "在聊的" });
    db.sessionRows.set("s-other", { id: "s-other", title: "旁的" });

    const r = await call<{ removed: boolean; active: string }>(
      "deleteSession",
      "s-other",
    );
    expect(r.removed).toBe(true);
    expect(r.active).toBe("s-live");
    expect(db.sessionRows.size).toBe(1);
  });

  it("ensureActiveSession：指向的场不在库 → 原样带回指向，不建行", () => {
    const { db, call } = harness({ activeSession: "s-draft", messages: [] });
    const id = call<string>("ensureActiveSession");
    expect(id).toBe("s-draft");
    expect(db.sessionRows.size).toBe(0);
  });

  it("空手的台子连上来（无指向）→ 立预备栏，不建行", () => {
    const { db, call } = harness({});
    const id = call<string>("ensureActiveSession");
    expect(id).toBeTruthy();
    expect(db.sessionRows.size).toBe(0);
  });

  it("老实例手上揣着没落过库的对话（无指向）→ 立刻收进库，名字用第一句", () => {
    const { db, call } = harness({
      messages: [userMsg("我们之前聊到的方案后来怎么样了")],
    });
    const id = call<string>("ensureActiveSession");
    expect(db.sessionRows.size).toBe(1);
    expect(db.sessionRows.get(id)!.named).toBe(1);
  });
});

describe("预备会话：开口才转正", () => {
  it("ensureRealSession：预备栏带着用户第一句话 → 落库，标题截第一句，等模型改名", () => {
    const { db, call } = harness({
      activeSession: "s-draft",
      messages: [userMsg("帮我看看这个方案可不可行，预算一千")],
    });
    const id = call<string>("ensureRealSession");
    expect(id).toBe("s-draft");
    const row = db.sessionRows.get(id)!;
    expect(row.title).toBe("帮我看看这个方案可不可行，预算一千".slice(0, 18));
    expect(row.named).toBe(0); // 名字留给模型：第一轮答完它会起一个更准的
  });

  it("ensureRealSession：已经在库里的场 → 原样返回，不重插", () => {
    const { db, call } = harness({ activeSession: "s-live" });
    db.sessionRows.set("s-live", { id: "s-live", title: "在聊的" });
    const id = call<string>("ensureRealSession");
    expect(id).toBe("s-live");
    expect(db.sessionRows.size).toBe(1);
  });

  it("点名开的会话（闲置归档路径）→ 直接落库，不进预备栏", async () => {
    const { db, call } = harness({ activeSession: "s-old" });
    db.sessionRows.set("s-old", { id: "s-old", title: "旧场" });

    const meta = await call<{ id: string; title: string; named: boolean }>(
      "createSession",
      "很久以前",
    );
    expect(meta).not.toBeNull();
    expect(meta.title).toBe("很久以前");
    expect(meta.named).toBe(true);
    expect(db.sessionRows.size).toBe(2); // 旧场 + 新落库的这场
  });
});
