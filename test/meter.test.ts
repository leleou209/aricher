/**
 * 写额度计量测试。
 *
 * 这里测的全是确定性那半：语句怎么归类、攒到什么时候落账、跨天怎么清。
 * 「到底是谁在吃额度」那半得靠真实数据，测不出来也不该编。
 *
 * 最要紧的两条：
 *   1. 计量器自己的落账不能被算进去 —— 否则账会自己长大（每记一笔多一笔）。
 *   2. 驱逐重启后数不能丢，也不能重复算。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect, vi } from "vitest";
import {
  Meter,
  classify,
  isDdl,
  isWrite,
  sqlText,
  utcDay,
  type MeterCell,
} from "../src/agent/meter";

/** 内存账本：模拟 write_meter 表 */
function fakeStore() {
  const rows = new Map<string, number>(); // "day|key" -> n
  return {
    rows,
    sink(day: string, cells: MeterCell[]) {
      for (const c of cells) {
        const k = `${day}|${c.key}`;
        rows.set(k, (rows.get(k) || 0) + c.n);
      }
    },
    loader(day: string) {
      const cells: MeterCell[] = [];
      for (const [k, n] of rows) {
        const [d, key] = k.split("|");
        if (d !== day) continue;
        cells.push({ key, n });
      }
      return cells;
    },
    total() {
      let n = 0;
      for (const v of rows.values()) n += v;
      return n;
    },
  };
}

function newMeter(store: ReturnType<typeof fakeStore>) {
  const m = new Meter();
  m.attach(
    (day, cells) => store.sink(day, cells),
    (day) => store.loader(day),
  );
  return m;
}

describe("sqlText / classify", () => {
  it("模板串拼成骨架，值用 ? 顶替", () => {
    const strings = Object.assign(["SELECT * FROM memories WHERE id = ", ""], {
      raw: [],
    }) as unknown as TemplateStringsArray;
    expect(sqlText(strings)).toBe("SELECT * FROM memories WHERE id = ?");
  });

  it("认得出写和读", () => {
    expect(isWrite("insert into a (x) values (?)")).toBe(true);
    expect(isWrite("update a set x = ?")).toBe(true);
    expect(isWrite("delete from a where x = ?")).toBe(true);
    expect(isWrite("select * from a")).toBe(false);
  });

  it("结构变更不算写入：建表是幂等空操作，算进去会虚报", () => {
    expect(isWrite("create table if not exists a (x text)")).toBe(false);
    expect(isWrite("create index if not exists i on a(x)")).toBe(false);
    expect(isWrite("alter table a add column y text")).toBe(false);
    expect(isDdl("create table if not exists a (x text)")).toBe(true);
    expect(isDdl("insert into a (x) values (?)")).toBe(false);
  });

  it("表名取对：建索引时表名在 on 后面，不是索引名", () => {
    expect(
      classify(
        "CREATE INDEX IF NOT EXISTS idx_memories_shelf ON memories(shelf)",
      ),
    ).toBe("create:memories");
  });

  it("各类语句都归到「动作:表」", () => {
    expect(
      classify("insert into cf_agents_state (id, state) values (?, ?)"),
    ).toBe("insert:cf_agents_state");
    expect(
      classify(
        "INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (?, ?)",
      ),
    ).toBe("insert:cf_agents_state");
    expect(classify("update memories set weight = ? where id = ?")).toBe(
      "update:memories",
    );
    expect(classify("delete from cf_ai_chat_agent_messages where id = ?")).toBe(
      "delete:cf_ai_chat_agent_messages",
    );
    expect(classify("select id, n from write_meter where day = ?")).toBe(
      "read:write_meter",
    );
  });

  it("引号包着的表名也认得", () => {
    expect(classify('insert into "memories" (id) values (?)')).toBe(
      "insert:memories",
    );
    expect(classify("insert into [memories] (id) values (?)")).toBe(
      "insert:memories",
    );
  });

  it("找不到表名就只留动作，不编一个出来", () => {
    expect(classify("pragma foreign_keys = on")).toBe("pragma");
  });

  it("空语句不炸", () => {
    expect(classify("")).toBe("other");
    expect(isWrite("")).toBe(false);
  });
});

describe("Meter", () => {
  it("写算写、读不算写", () => {
    const store = fakeStore();
    const m = newMeter(store);
    m.note("insert into a (x) values (?)");
    m.note("select * from a", 7);
    expect(m.report().writes).toBe(1);
    expect(m.report().reads).toBe(7);
  });

  it("排行榜里只有写 —— 读比写多得多，混进来会把真正的元凶挤出前八", () => {
    const store = fakeStore();
    const m = newMeter(store);
    m.note("insert into a (x) values (?)");
    m.note("select * from a", 9999);
    const rep = m.report();
    expect(rep.top.map((t) => t.key)).toEqual(["insert:a"]);
    expect(rep.reads).toBe(9999); // 读还是照数，只是不进榜
  });

  it("建表一条都不记 —— 唤醒时那十几条 DDL 不该变成账面上的几万行", () => {
    const store = fakeStore();
    const m = newMeter(store);
    m.note("CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY)");
    m.note("CREATE INDEX IF NOT EXISTS idx ON memories(id)");
    expect(m.report().writes).toBe(0);
    expect(m.report().top).toEqual([]);
  });

  it("没落账之前，report 也能看到内存里那些", () => {
    const store = fakeStore();
    const m = newMeter(store);
    m.note("insert into a (x) values (?)");
    // report 会先落一次账，所以这里既是「看得到」也是「落下来了」
    expect(m.report().writes).toBe(1);
    expect(store.total()).toBeGreaterThan(0);
  });

  it("计量器自己的落账不会被算进去（不然账会自己长大）", () => {
    const store = fakeStore();
    const m = newMeter(store);
    m.note("insert into a (x) values (?)");
    m.flush();
    // 落账本身发的是 write_meter 的写；如果被计进去，writes 会一直涨
    expect(m.report().writes).toBe(1);
  });

  it("同一个来源会累加，不是覆盖", () => {
    const store = fakeStore();
    const m = newMeter(store);
    for (let i = 0; i < 3; i++) m.note("insert into a (x) values (?)");
    m.flush();
    m.note("insert into a (x) values (?)");
    expect(m.report().writes).toBe(4);
    expect(store.loader(utcDay()).find((c) => c.key === "insert:a")?.n).toBe(4);
  });

  it("驱逐重启后从账本接回来，数不丢也不重复算", () => {
    const store = fakeStore();
    const a = newMeter(store);
    for (let i = 0; i < 5; i++) a.note("insert into a (x) values (?)");
    a.flush();

    // 新实例（同一个库）
    const b = newMeter(store);
    b.note("insert into b (x) values (?)");
    expect(b.report().writes).toBe(6);
  });

  it("跨天清空重来：昨天的账不算在今天头上", () => {
    const store = fakeStore();
    const m = newMeter(store);
    m.note("insert into a (x) values (?)");
    m.flush();
    const tomorrow = Date.now() + 86400000;
    vi.spyOn(Date, "now").mockReturnValue(tomorrow);
    try {
      expect(m.report().day).toBe(utcDay(tomorrow));
      expect(m.report().writes).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("排行榜按次数降序，只给前几名", () => {
    const store = fakeStore();
    const m = newMeter(store);
    for (let i = 0; i < 3; i++) m.note("insert into hot (x) values (?)");
    m.note("insert into cold (x) values (?)");
    const top = m.report().top;
    expect(top[0]).toEqual({ key: "insert:hot", n: 3 });
    expect(top.find((t) => t.key === "insert:cold")?.n).toBe(1);
  });

  it("落账失败不丢账，下次接着记", () => {
    const store = fakeStore();
    const m = new Meter();
    let boom = true;
    m.attach(
      (day, cells) => {
        if (boom) throw new Error("额度满了");
        store.sink(day, cells);
      },
      (day) => store.loader(day),
    );
    m.note("insert into a (x) values (?)");
    m.flush(); // 这次会抛，账留在内存里
    boom = false;
    expect(m.report().writes).toBe(1);
    expect(store.loader(utcDay()).find((c) => c.key === "insert:a")?.n).toBe(1);
  });

  it("账本里的旧结构变更不计数：修好口径之前落下的那些不该还挂在账上", () => {
    const store = fakeStore();
    store.sink(utcDay(), [{ key: "create:cf_agents_state", n: 40 }]);
    store.sink(utcDay(), [{ key: "insert:memories", n: 3 }]);
    const m = newMeter(store);
    const rep = m.report();
    expect(rep.writes).toBe(3);
    expect(rep.top.map((t) => t.key)).toEqual(["insert:memories"]);
  });

  it("一轮报一次：turn 之后增量归零", () => {
    const store = fakeStore();
    const m = newMeter(store);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      m.note("insert into a (x) values (?)");
      m.note("insert into a (x) values (?)");
      m.turn("回答");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain("这一轮写了 2 行");
      // 没有新增就不出声 —— 每轮都报一次「写了 0 行」就是噪音
      spy.mockClear();
      m.turn("回答");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
