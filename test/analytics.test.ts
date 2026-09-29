/**
 * 官方用量校准测试（src/analytics.ts）。
 *
 * 钉死三件事：
 *   1. 没配 token 是「未接入」不是错误 —— 安静地回 null，面板退回自计量。
 *   2. 两段查询各自独立 —— DO 那段字段名对不上（200 + errors）不能连累请求数。
 *   3. 缓存 —— 面板狂点刷新不该狂发 GraphQL；成功存 60 秒、失败存 30 秒。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchOfficialUsage, resetAnalyticsCache } from "../src/analytics";

/** 固定基准：2026-09-24T06:00:00Z，查询窗口应为当日 UTC 零点到现在 */
const T = Date.UTC(2026, 8, 24, 6, 0, 0);

const env = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acct" } as unknown as Env;
const noToken = { CF_ACCOUNT_ID: "acct" } as unknown as Env;
const noAccount = { CF_API_TOKEN: "tok" } as unknown as Env;

interface FetchCall {
  query: string;
  variables: Record<string, string>;
}

/**
 * 按查询里出现的数据集名分发假响应。
 * workers / do 各自给一个工厂：返回响应对象，或 throw 模拟网络失败。
 */
function stubFetch(handlers: { workers?: () => unknown; do?: () => unknown }) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    const kind = body.query.includes("workersInvocationsAdaptive")
      ? "workers"
      : "do";
    calls.push({ query: body.query, variables: body.variables });
    const make = handlers[kind];
    if (!make) return { ok: false, json: async () => ({}) } as Response;
    const payload = make();
    if (payload instanceof Error) throw payload;
    return { ok: true, json: async () => payload } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

const workersOk =
  (requests: number, errors = 0, subrequests = 0) =>
  () => ({
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: [
              { sum: { requests, errors, subrequests } },
            ],
          },
        ],
      },
    },
  });

const doOk = (rowsRead: number, rowsWritten: number) => () => ({
  data: {
    viewer: {
      accounts: [
        { durableObjectsPeriodicGroups: [{ sum: { rowsRead, rowsWritten } }] },
      ],
    },
  },
});

/** 字段名对不上时接口的样子：200 + errors */
const gqlErrors = () => ({ errors: [{ message: "unknown field" }] });

afterEach(() => {
  vi.unstubAllGlobals();
  resetAnalyticsCache();
});

describe("fetchOfficialUsage 未接入", () => {
  it("没配 token：回 null，一个请求都不发", async () => {
    const { fn } = stubFetch({});
    expect(await fetchOfficialUsage(noToken, T)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("没配账号 id：同样安静地 null", async () => {
    const { fn } = stubFetch({});
    expect(await fetchOfficialUsage(noAccount, T)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("fetchOfficialUsage 解析", () => {
  it("两段都成功：数字齐全，日期是当日 UTC 日", async () => {
    stubFetch({ workers: workersOk(123, 2, 45), do: doOk(9000, 321) });
    const rep = await fetchOfficialUsage(env, T);
    expect(rep).not.toBeNull();
    expect(rep?.day).toBe("2026-09-24");
    expect(rep?.requests).toBe(123);
    expect(rep?.errors).toBe(2);
    expect(rep?.subrequests).toBe(45);
    expect(rep?.sqlRowsRead).toBe(9000);
    expect(rep?.sqlRowsWritten).toBe(321);
    expect(rep?.fetchedAt).toBe(T);
  });

  it("查询窗口 = 当日 UTC 零点到此刻", async () => {
    const { calls } = stubFetch({ workers: workersOk(1), do: doOk(1, 1) });
    await fetchOfficialUsage(env, T);
    for (const c of calls) {
      expect(c.variables.geq).toBe("2026-09-24T00:00:00.000Z");
      expect(c.variables.leq).toBe(new Date(T).toISOString());
      expect(c.variables.accountTag).toBe("acct");
    }
  });

  it("DO 段字段名对不上（200 + errors）：只丢那一段，请求数照给", async () => {
    stubFetch({ workers: workersOk(77), do: gqlErrors });
    const rep = await fetchOfficialUsage(env, T);
    expect(rep?.requests).toBe(77);
    expect(rep?.sqlRowsWritten).toBeNull();
    expect(rep?.sqlRowsRead).toBeNull();
  });

  it("Workers 段 HTTP 500、DO 段成功：读写字段有、请求数为 null", async () => {
    stubFetch({ do: doOk(10, 5) });
    const rep = await fetchOfficialUsage(env, T);
    expect(rep?.requests).toBeNull();
    expect(rep?.sqlRowsWritten).toBe(5);
  });

  it("网络整个炸了：null，不抛", async () => {
    stubFetch({
      workers: () => new Error("fetch failed"),
      do: () => new Error("fetch failed"),
    });
    expect(await fetchOfficialUsage(env, T)).toBeNull();
  });

  it("两段都空手而归：整体 null，面板好退回自计量口径", async () => {
    stubFetch({ workers: gqlErrors, do: gqlErrors });
    expect(await fetchOfficialUsage(env, T)).toBeNull();
  });
});

describe("缓存", () => {
  it("60 秒内重复刷新只发一轮 GraphQL", async () => {
    const { fn } = stubFetch({ workers: workersOk(5), do: doOk(5, 5) });
    await fetchOfficialUsage(env, T);
    expect(fn).toHaveBeenCalledTimes(2); // 两段各一次
    await fetchOfficialUsage(env, T + 30_000);
    expect(fn).toHaveBeenCalledTimes(2); // 命中缓存，没再发
  });

  it("失败也缓存 30 秒：坏配置不会被狂点打爆", async () => {
    const { fn } = stubFetch({ workers: gqlErrors, do: gqlErrors });
    expect(await fetchOfficialUsage(env, T)).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(await fetchOfficialUsage(env, T + 10_000)).toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("过了缓存期会重新查", async () => {
    const { fn } = stubFetch({ workers: workersOk(5), do: doOk(5, 5) });
    await fetchOfficialUsage(env, T);
    await fetchOfficialUsage(env, T + 61_000);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("resetAnalyticsCache 立刻清掉缓存", async () => {
    const { fn } = stubFetch({ workers: workersOk(5), do: doOk(5, 5) });
    await fetchOfficialUsage(env, T);
    resetAnalyticsCache();
    await fetchOfficialUsage(env, T + 1_000);
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
