// 官方用量校准：向 Cloudflare 的 GraphQL Analytics 接口要精确数字。
//
// 为什么不只信自计量（meter.ts / usage.ts）：自己埋的账只盖得住自己走过的路，
// 而请求数和 SQL 读写行是整账号按天结算的 —— 平台侧的数才是账单上的那个。
// 官方接口查得到这两样（Workers 请求、Durable Object 的 rowsRead/rowsWritten），
// 查不到 neurons 和 Vectorize —— 那两样只能继续自计量，两边在面板上汇到一起。
//
// 代价与口径：
//   - 要一个免费的 API Token（Analytics:Read 权限），没配就整段退回自计量；
//   - 官方数据有几分钟延迟，面板上如实标注；
//   - 两段查询各自独立：DO 那段的字段名以线上 schema 为准，查失败只丢那一段，
//     不连累 Workers 请求数。

/** 今日（UTC）账号侧的精确用量。拿不到的字段是 null，不是零。 */
export interface OfficialUsage {
  day: string;
  /** 本 Worker 今天的请求数 */
  requests: number | null;
  errors: number | null;
  subrequests: number | null;
  /** 全账号 DO 今天读的总行数（额度本来就是账号级的，全账号口径才是对的） */
  sqlRowsRead: number | null;
  sqlRowsWritten: number | null;
  /** 这份数是几点拿到的（毫秒时间戳），面板上标延迟用 */
  fetchedAt: number;
}

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
/** 本 Worker 的名字（wrangler.jsonc 的 name）。请求数按脚本过滤，看的是这间屋子的账。 */
const SCRIPT_NAME = "cowork-agent";

const WORKERS_QUERY = /* GraphQL */ `
  query Usage($accountTag: String!, $geq: String!, $leq: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 10
          filter: { scriptName: "${SCRIPT_NAME}", datetime_geq: $geq, datetime_leq: $leq }
        ) {
          sum {
            requests
            errors
            subrequests
          }
        }
      }
    }
  }
`;

const DO_QUERY = /* GraphQL */ `
  query Usage($accountTag: String!, $geq: String!, $leq: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        durableObjectsPeriodicGroups(
          limit: 10000
          filter: { datetime_geq: $geq, datetime_leq: $leq }
        ) {
          sum {
            rowsRead
            rowsWritten
          }
        }
      }
    }
  }
`;

interface GqlResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        workersInvocationsAdaptive?: Array<{
          sum?: { requests?: number; errors?: number; subrequests?: number };
        }>;
        durableObjectsPeriodicGroups?: Array<{
          sum?: { rowsRead?: number; rowsWritten?: number };
        }>;
      }>;
    };
  };
  errors?: unknown[];
}

/** 模块级缓存：面板一开、刷新一点就发 GraphQL 的话，白烧子请求。
 *  成功存 60 秒，失败也存 30 秒（免得坏配置被狂点）。测试用 resetCache 清。 */
let cache: { value: OfficialUsage | null; until: number } | null = null;

export function resetAnalyticsCache(): void {
  cache = null;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function gql(
  env: Env,
  query: string,
  variables: Record<string, string>,
): Promise<GqlResponse["data"] | null> {
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as GqlResponse;
    // 字段名对不上时接口回的是 200 + errors —— 那也算这段没查到
    if (json.errors?.length) return null;
    return json.data ?? null;
  } catch {
    return null;
  }
}

/**
 * 拿今天的官方用量。没配 token / 账号 id → null（这是「未接入」，不是错误）。
 * 两段查询都空手而归也 → null，让面板明确显示「只有自计量」。
 */
export async function fetchOfficialUsage(
  env: Env,
  now = Date.now(),
): Promise<OfficialUsage | null> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null;
  if (cache && now < cache.until) return cache.value;

  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const variables = {
    accountTag: env.CF_ACCOUNT_ID,
    geq: d.toISOString(),
    leq: new Date(now).toISOString(),
  };

  const [w, o] = await Promise.all([
    gql(env, WORKERS_QUERY, variables),
    gql(env, DO_QUERY, variables),
  ]);

  const ws = w?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0]?.sum;
  const ds = o?.viewer?.accounts?.[0]?.durableObjectsPeriodicGroups?.[0]?.sum;

  const value: OfficialUsage | null =
    ws || ds
      ? {
          day: utcDay(now),
          requests: ws?.requests ?? null,
          errors: ws?.errors ?? null,
          subrequests: ws?.subrequests ?? null,
          sqlRowsRead: ds?.rowsRead ?? null,
          sqlRowsWritten: ds?.rowsWritten ?? null,
          fetchedAt: now,
        }
      : null;

  cache = { value, until: now + (value ? 60_000 : 30_000) };
  return value;
}
