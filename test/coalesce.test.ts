/**
 * 流压粗（coalesce）测试。
 *
 * 为什么这层必须测死：它站在「模型输出」和「平台落库」中间 —— 平台是**一个流式事件
 * 一行 SQLite**，所以这里合并得对不对，直接决定两件事：额度（少写多少行）
 * 和能不能说话（事件发错形状，前端就一个字都不显示）。
 *
 * 断言分两类：
 *   - 该省的省了：条数明显下降（这是它存在的理由）；
 *   - 一个都不能少：合并后的文本与原来逐字相同、顺序不乱、非增量事件原样透传。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import { coalesceStream } from "../src/agent/coalesce";

const enc = new TextEncoder();
const dec = new TextDecoder();

type Ev = Record<string, unknown>;

/** 一段 SSE：`data: {json}\n\n` */
function sse(...items: (Ev | string)[]): string {
  return items
    .map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`)
    .join("");
}

function delta(id: string, text: string): Ev {
  // toUIMessageStream 的形状是 text（readUIMessageStream 才用 delta），两种都要认
  return { type: "text-delta", id, text };
}

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

async function run(
  sseText: string,
  opts?: Parameters<typeof coalesceStream>[1],
): Promise<string> {
  const res = coalesceStream(new Response(streamOf([sseText])), opts);
  return await new Response(res.body).text();
}

/** 输出里的事件（跳过收尾标记） */
function events(out: string): Ev[] {
  return out
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Ev);
}

/** 把事件里的文字拼回来，跟原始文本比对用 */
function textOf(list: Ev[], id: string): string {
  return list
    .filter((e) => e.type === "text-delta" && e.id === id)
    .map((e) => String(e.text ?? e.delta ?? ""))
    .join("");
}

describe("coalesceStream", () => {
  it("同一段的一百个分片压成一条，文字一个不差", async () => {
    const chars = Array.from({ length: 100 }, (_, i) => `字${i}`);
    const out = await run(
      sse(...chars.map((c) => delta("t1", c)), " [DONE]".slice(1)),
      {
        windowMs: 10_000,
        maxChars: 10_000,
      },
    );
    const list = events(out);
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe("text-delta");
    expect(list[0].id).toBe("t1");
    expect(textOf(list, "t1")).toBe(chars.join(""));
    // 收尾标记仍在，且排在内容之后
    expect(out.indexOf("data: [DONE]")).toBeGreaterThan(out.indexOf("字99"));
    // 原本 101 条 data 行，现在只剩 2 条
    expect(out.split("\n").filter((l) => l.startsWith("data: "))).toHaveLength(
      2,
    );
  });

  it("顺序不乱：start / text-start / 合并后的正文 / text-end / finish", async () => {
    const out = await run(
      sse(
        { type: "start", messageId: "m1" },
        { type: "text-start", id: "t1" },
        delta("t1", "你"),
        delta("t1", "好"),
        delta("t1", "呀"),
        { type: "text-end", id: "t1" },
        { type: "finish-step" },
        "[DONE]",
      ),
      { windowMs: 10_000 },
    );
    const list = events(out);
    expect(list.map((e) => e.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
    ]);
    expect(textOf(list, "t1")).toBe("你好呀");
  });

  it("换了一段就断开，两条正文各归各的", async () => {
    const out = await run(
      sse(
        delta("t1", "前"),
        delta("t1", "半"),
        delta("t2", "后"),
        delta("t2", "半"),
      ),
      {
        windowMs: 10_000,
      },
    );
    const list = events(out);
    expect(list).toHaveLength(2);
    expect(textOf(list, "t1")).toBe("前半");
    expect(textOf(list, "t2")).toBe("后半");
  });

  it("非增量事件到来前先把攒着的发出去（顺序不会倒）", async () => {
    const out = await run(
      sse(delta("t1", "先"), delta("t1", "说话"), {
        type: "tool-input-start",
        toolCallId: "c1",
        toolName: "note",
      }),
      { windowMs: 10_000 },
    );
    const list = events(out);
    expect(list.map((e) => e.type)).toEqual(["text-delta", "tool-input-start"]);
    expect(textOf(list, "t1")).toBe("先说话");
  });

  it("攒够字数就发一条，不必等窗口", async () => {
    const long = "字".repeat(400);
    const out = await run(sse(delta("t1", long), delta("t1", "尾")), {
      windowMs: 10_000,
      maxChars: 400,
    });
    const list = events(out);
    expect(list.length).toBeGreaterThan(1);
    expect(textOf(list, "t1")).toBe(long + "尾");
  });

  it("窗口到点自己发出去，不等下一条事件", async () => {
    let push!: (s: string) => void;
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        push = (s) => c.enqueue(enc.encode(s));
        close = () => c.close();
      },
    });
    const res = coalesceStream(new Response(body), { windowMs: 20 });
    const reader = res.body!.getReader();

    // 只喂一条分片就不再喂：这一读要能返回，只能是定时器把它发了出去
    push(sse(delta("t1", "半天")));
    const first = dec.decode((await reader.read()).value);
    expect(first).toContain("半天");

    close();
    while (!(await reader.read()).done) {
      // 收干净
    }
  });

  it("带 providerMetadata 的分片不合并（标注要留在原地）", async () => {
    const out = await run(
      sse(
        { ...delta("t1", "甲"), providerMetadata: { x: 1 } },
        { ...delta("t1", "乙"), providerMetadata: { x: 2 } },
      ),
      { windowMs: 10_000 },
    );
    const list = events(out);
    expect(list).toHaveLength(2);
    expect(list[0].providerMetadata).toEqual({ x: 1 });
    expect(list[1].providerMetadata).toEqual({ x: 2 });
  });

  it("tool-input-delta 默认原样过（它是 JSON 片段）", async () => {
    const out = await run(
      sse(
        { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"a"' },
        { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: ":1}" },
      ),
      { windowMs: 10_000 },
    );
    const list = events(out);
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.inputTextDelta)).toEqual(['{"a"', ":1}"]);
  });

  it("网络把一行切开也能拼回来", async () => {
    const whole = sse({ type: "start", messageId: "m1" }, delta("t1", "你好"), {
      type: "text-end",
      id: "t1",
    });
    const cut = Math.floor(whole.length / 2);
    const res = coalesceStream(
      new Response(streamOf([whole.slice(0, cut), whole.slice(cut)])),
      {
        windowMs: 10_000,
      },
    );
    const list = events(await new Response(res.body).text());
    expect(list.map((e) => e.type)).toEqual([
      "start",
      "text-delta",
      "text-end",
    ]);
    expect(textOf(list, "t1")).toBe("你好");
  });

  it("响应头与状态码照旧带过去", async () => {
    const src = new Response(streamOf([sse(delta("t1", "嗨"))]), {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
    const res = coalesceStream(src);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("认不出来的行照原样放过去，不把这一轮弄哑", async () => {
    const out = await run("data: {这不是 JSON}\n\n", { windowMs: 10_000 });
    expect(out).toContain("data: {这不是 JSON}");
  });
});
