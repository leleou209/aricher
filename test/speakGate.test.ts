/**
 * 「该不该开口」门控测试。
 *
 * 三件事要证：
 *   一、安静时段的边界算得准（跨零点那一档最容易错）
 *   二、按到早上是「推迟」而不是「丢掉」—— 早上那一下必须还能捞回来
 *   三、攒着的几句话怎么合并：同一场合成一条，不同场不许并到一起
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import {
  QUIET_END_HOUR,
  beijingDayStart,
  beijingHour,
  countSaysSince,
  enqueueSay,
  inQuietHours,
  listPendingSays,
  markSaysDelivered,
  mergeSays,
  pruneSays,
  quietEndsAt,
} from "../src/agent/speakGate";
import type { SqlTag } from "../src/agent/state";

/** 只认这几条语句的假库。不追求通用，够验队列这一件事就行。 */
function fakeDb() {
  const rows: Array<{
    id: string;
    session_id: string;
    line: string;
    created: string;
    delivered: number;
  }> = [];

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table") || sql.startsWith("create index"))
      return [] as T[];

    if (sql.startsWith("insert into proactive_says")) {
      const [id, session_id, line, created] = values as string[];
      rows.push({ id, session_id, line, created, delivered: 0 });
      return [] as T[];
    }

    if (
      sql.startsWith("select id, session_id, line, created from proactive_says")
    ) {
      return rows
        .filter((r) => r.delivered === 0)
        .sort((a, b) => a.created.localeCompare(b.created))
        .map((r) => ({
          id: r.id,
          session_id: r.session_id,
          line: r.line,
          created: r.created,
        })) as T[];
    }

    if (
      sql.startsWith("update proactive_says set delivered = 1 where id = ?")
    ) {
      const [id] = values as string[];
      for (const r of rows) if (r.id === id) r.delivered = 1;
      return [] as T[];
    }

    if (sql.startsWith("select count(*) as n from proactive_says")) {
      const [since] = values as string[];
      const n = rows.filter(
        (r) => r.delivered === 1 && r.created >= since,
      ).length;
      return [{ n }] as T[];
    }

    if (sql.startsWith("delete from proactive_says where created < ?")) {
      const [before] = values as string[];
      for (let i = rows.length - 1; i >= 0; i--)
        if (rows[i].created < before) rows.splice(i, 1);
      return [] as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return { db, rows };
}

// 北京时间 = UTC+8，写用例时直接给带偏移的字符串，省得心算
const bj = (s: string) => new Date(s);

describe("安静时段", () => {
  it("23 点到次日 8 点算安静，白天不算", () => {
    expect(inQuietHours(bj("2026-09-19T22:59:00+08:00"))).toBe(false);
    expect(inQuietHours(bj("2026-09-19T23:00:00+08:00"))).toBe(true);
    expect(inQuietHours(bj("2026-09-20T00:30:00+08:00"))).toBe(true);
    expect(inQuietHours(bj("2026-09-20T07:59:00+08:00"))).toBe(true);
    expect(inQuietHours(bj("2026-09-20T08:00:00+08:00"))).toBe(false);
    expect(inQuietHours(bj("2026-09-20T12:00:00+08:00"))).toBe(false);
  });

  it("按北京时间读小时，不按 UTC", () => {
    // UTC 的 16:00 就是北京的次日 0 点 —— 拿错时区的话这里会读成 16
    expect(beijingHour(new Date("2026-09-19T16:00:00Z"))).toBe(0);
    expect(beijingHour(bj("2026-09-19T09:00:00+08:00"))).toBe(9);
  });

  it("凌晨那条按到当天早上八点", () => {
    const end = quietEndsAt(bj("2026-09-20T03:00:00+08:00"));
    expect(end).not.toBeNull();
    expect(end!.toISOString()).toBe(
      new Date("2026-09-20T08:00:00+08:00").toISOString(),
    );
  });

  it("深夜那条按到第二天早上八点（跨零点）", () => {
    const end = quietEndsAt(bj("2026-09-19T23:30:00+08:00"));
    expect(end).not.toBeNull();
    expect(end!.toISOString()).toBe(
      new Date("2026-09-20T08:00:00+08:00").toISOString(),
    );
  });

  it("白天不推迟", () => {
    expect(quietEndsAt(bj("2026-09-19T15:00:00+08:00"))).toBeNull();
  });

  it("按到早上的时刻一定在安静时段之外 —— 否则会再被按一次，永远说不出话", () => {
    for (const t of [
      "2026-09-19T23:00:00+08:00",
      "2026-09-20T00:00:00+08:00",
      "2026-09-20T07:59:00+08:00",
    ]) {
      const end = quietEndsAt(bj(t))!;
      expect(inQuietHours(end)).toBe(false);
      expect(beijingHour(end)).toBe(QUIET_END_HOUR);
    }
  });

  it("「今天」按北京时间切，不按 UTC", () => {
    // 北京 9/20 凌晨 1 点 = UTC 9/19 17 点。按 UTC 算会把今天算成 9/19
    const start = beijingDayStart(bj("2026-09-20T01:00:00+08:00"));
    expect(start).toBe(new Date("2026-09-20T00:00:00+08:00").toISOString());
  });
});

describe("攒话队列", () => {
  it("入队后是待发状态，标过已发就不再出现", () => {
    const { db } = fakeDb();
    const a = enqueueSay(db, "s1", "第一句");
    enqueueSay(db, "s1", "第二句");
    expect(listPendingSays(db)).toHaveLength(2);

    markSaysDelivered(db, [a.id]);
    const left = listPendingSays(db);
    expect(left).toHaveLength(1);
    expect(left[0].line).toBe("第二句");
  });

  it("只数说出口的，且只数今天的", () => {
    const { db, rows } = fakeDb();
    const old = enqueueSay(db, "s1", "上个月说的");
    const fresh = enqueueSay(db, "s1", "刚才说的");
    markSaysDelivered(db, [old.id, fresh.id]);
    // 把其中一条挪到上个月：历史记录还在，但不该算进「今天说了几次」
    rows[0].created = new Date(Date.now() - 40 * 86400_000).toISOString();

    expect(countSaysSince(db, beijingDayStart())).toBe(1);
  });

  it("旧记录会被清掉", () => {
    const { db, rows } = fakeDb();
    enqueueSay(db, "s1", "很久以前");
    pruneSays(db, Date.now() + 40 * 86400_000);
    expect(rows).toHaveLength(0);
  });
});

describe("合并", () => {
  const say = (
    sessionId: string,
    line: string,
    created = "2026-09-19T10:00:00Z",
  ) => ({
    id: line,
    sessionId,
    line,
    created,
  });

  it("一条就是一条，不加引子", () => {
    const out = mergeSays([say("s1", "你让我盯的那个页面有动静了")]);
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe("你让我盯的那个页面有动静了");
    expect(out[0].ids).toEqual(["你让我盯的那个页面有动静了"]);
  });

  it("同一场的两条并成一条，中间空行隔开", () => {
    const out = mergeSays([say("s1", "甲"), say("s1", "乙")]);
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe("甲\n\n乙");
  });

  it("三条以上给个引子，免得像刷屏", () => {
    const out = mergeSays([say("s1", "甲"), say("s1", "乙"), say("s1", "丙")]);
    expect(out[0].line.startsWith("几件事一起说：")).toBe(true);
  });

  it("不同场的绝不并到一起 —— 那些话属于各自那一场", () => {
    const out = mergeSays([say("s1", "甲"), say("s2", "乙")]);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("ids 带全，flush 才能一条不落地标成已发", () => {
    const out = mergeSays([say("s1", "甲"), say("s1", "乙")]);
    expect(out[0].ids).toEqual(["甲", "乙"]);
  });
});
