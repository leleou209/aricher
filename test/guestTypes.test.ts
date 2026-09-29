/**
 * 多档来客类型（guest_types）测试。
 *
 * 验的是「分档靠不靠得住」这件事的三面：
 * - 名册本身的增删改查：perm 开关按档位存取，字段缺省不动；
 * - 密码查重：和两个内置口令、和已有各档都不许重 —— 重了「分档」就分不出人；
 * - 门口验密码：内置口令直接排除，停用的档不开门，命中才给行。
 * 另有一组用例盯着 buildTools：档位关掉的工具组必须真的不注册（工具没到手，
 * 比「到手了再拦」可靠），visitor_log 恒在，主人那间不受档位影响。
 *
 * 名册用最小假 SQL 引擎，只认得 guestTypes.ts 会发的那几条语句。
 *
 * 运行: npx vitest run test/guestTypes.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  createGuestType,
  disabledGuestTypeInfo,
  findGuestTypeByPassword,
  getGuestType,
  listGuestTypes,
  removeGuestType,
  toGuestTypeInfo,
  updateGuestType,
} from "../src/agent/guestTypes";
import { INITIAL_STATE, type SqlTag } from "../src/agent/state";
import { buildTools } from "../src/tools";
import type { ToolCtx } from "../src/tools/types";

const ENV_PW = { adminPw: "guanli", gatePw: "qiantai" };

/** 最小假 SQL 引擎：行存成 snake_case，语句按前缀认 */
function fakeDb() {
  const rows: Array<{
    id: string;
    name: string;
    password: string;
    note: string;
    perm_search: number;
    perm_draw: number;
    perm_memory: number;
    perm_notes: number;
    perm_files: number;
    perm_public: number;
    active: number;
    created: string;
  }> = [];

  const db = (<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    if (sql.startsWith("create table")) return [] as T[];

    // 老库补列的 ALTER：真库靠 try/catch 容错，假库直接当跑成了
    if (sql.startsWith("alter table")) return [] as T[];

    if (sql.startsWith("insert into guest_types")) {
      const [
        id,
        name,
        password,
        note,
        ps,
        pd,
        pm,
        pn,
        pf,
        pp,
        active,
        created,
      ] = values as [
        string,
        string,
        string,
        string,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        string,
      ];
      rows.push({
        id,
        name,
        password,
        note,
        perm_search: Number(ps),
        perm_draw: Number(pd),
        perm_memory: Number(pm),
        perm_notes: Number(pn),
        perm_files: Number(pf),
        perm_public: Number(pp),
        active: Number(active),
        created,
      });
      return [] as T[];
    }

    if (sql.startsWith("update guest_types set")) {
      const [name, password, note, ps, pd, pm, pn, pf, pp, active, id] =
        values as [
          string,
          string,
          string,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          string,
        ];
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("假库：update 没找到行");
      Object.assign(row, {
        name,
        password,
        note,
        perm_search: Number(ps),
        perm_draw: Number(pd),
        perm_memory: Number(pm),
        perm_notes: Number(pn),
        perm_files: Number(pf),
        perm_public: Number(pp),
        active: Number(active),
      });
      return [] as T[];
    }

    if (sql.startsWith("delete from guest_types")) {
      const [id] = values as [string];
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return [] as T[];
    }

    if (sql.startsWith("select id from guest_types")) {
      const [id] = values as [string];
      return rows.filter((r) => r.id === id).map((r) => ({ id: r.id })) as T[];
    }

    if (sql.startsWith("select id, name, password")) {
      // 三种查询：按 id（权益核实）、按 active（门口验密码）、按 id+active（同前者，
      // 但停用的档连「按 id 查」也要当查无此档 —— 旧票旧卡的权益核实走的就是它）
      const byId = sql.includes("where id =")
        ? rows.filter((r) => r.id === (values[0] as string))
        : [...rows];
      return (
        sql.includes("active = 1") ? byId.filter((r) => r.active === 1) : byId
      ) as T[];
    }

    throw new Error("假库不认得这条语句：" + sql);
  }) as unknown as SqlTag;

  return { db, rows };
}

describe("guest_types 增删改查", () => {
  it("建一档读得回来：perm 缺省全开、id 是 8 位 hex、active 默认启用", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "合作方",
      password: "hz-2026",
      ...ENV_PW,
    });
    expect(t.id).toMatch(/^[0-9a-f]{8}$/);
    expect(t.name).toBe("合作方");
    expect(t.password).toMatch(/^[0-9a-f]{64}$/);
    expect(t.permSearch).toBe(true);
    expect(t.permDraw).toBe(true);
    expect(t.permMemory).toBe(true);
    expect(t.active).toBe(true);
    expect(t.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(listGuestTypes(db).map((x) => x.name)).toEqual(["合作方"]);
  });

  it("perm 明确关掉就是关掉，没提的仍全开", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "受限档",
      password: "p1",
      permSearch: false,
      permMemory: false,
      ...ENV_PW,
    });
    expect(t.permSearch).toBe(false);
    expect(t.permDraw).toBe(true);
    expect(t.permMemory).toBe(false);
  });

  it("改一档：字段缺省不动，active 能停用，名称与说明能改", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "旧名",
      password: "p1",
      note: "旧说明",
      ...ENV_PW,
    });
    const up = await updateGuestType(db, t.id, {
      name: "新名",
      note: "新说明",
      active: false,
      ...ENV_PW,
    });
    expect(up?.name).toBe("新名");
    expect(up?.note).toBe("新说明");
    expect(up?.active).toBe(false);
    expect(up?.password).toMatch(/^[0-9a-f]{64}$/);
    expect(up?.permSearch).toBe(true);
  });

  it("没有这一档：改返回 null，删返回 false", async () => {
    const { db } = fakeDb();
    expect(await updateGuestType(db, "nope", { ...ENV_PW })).toBeNull();
    expect(removeGuestType(db, "nope")).toBe(false);
  });

  it("删一档", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "临时档",
      password: "p1",
      ...ENV_PW,
    });
    expect(removeGuestType(db, t.id)).toBe(true);
    expect(listGuestTypes(db)).toHaveLength(0);
  });
});

describe("停用的档：新登录不开门，按 id 查也当查无此档", () => {
  it("getGuestType 对停用的档返回 null —— 旧票旧卡的权益核实走这条，null 由上层回落全关", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "停用档",
      password: "ty-2026",
      ...ENV_PW,
    });
    // 启用时按 id 查得到
    expect(getGuestType(db, t.id)!.id).toBe(t.id);
    await updateGuestType(db, t.id, { active: false, ...ENV_PW });
    // 停用后按 id 查就是查无此档：30 天的旧票、名下的旧卡都拿不到这一档的权益，
    // 「收回」不再只剩删档一条路
    expect(getGuestType(db, t.id)).toBeNull();
    // 面板看名册不受影响：停用的档还在列表里
    expect(listGuestTypes(db)).toHaveLength(1);
  });
});

describe("密码查重", () => {
  it("与管理员口令撞了：抛", async () => {
    const { db } = fakeDb();
    await expect(
      createGuestType(db, { name: "x", password: "guanli", ...ENV_PW }),
    ).rejects.toThrow(/管理员口令/);
  });

  it("与前台口令撞了：抛", async () => {
    const { db } = fakeDb();
    await expect(
      createGuestType(db, { name: "x", password: "qiantai", ...ENV_PW }),
    ).rejects.toThrow(/前台口令/);
  });

  it("与已有档位撞了：抛；只改名不碰密码不查重", async () => {
    const { db } = fakeDb();
    await createGuestType(db, { name: "a", password: "p1", ...ENV_PW });
    await expect(
      createGuestType(db, { name: "b", password: "p1", ...ENV_PW }),
    ).rejects.toThrow(/在用/);
    const b = await createGuestType(db, {
      name: "b",
      password: "p2",
      ...ENV_PW,
    });
    expect(
      (await updateGuestType(db, b.id, { name: "b2", ...ENV_PW }))?.name,
    ).toBe("b2");
  });

  it("改成别人的密码：抛；原样保留自己的密码：不算撞", async () => {
    const { db } = fakeDb();
    await createGuestType(db, { name: "a", password: "p1", ...ENV_PW });
    const b = await createGuestType(db, {
      name: "b",
      password: "p2",
      ...ENV_PW,
    });
    await expect(
      updateGuestType(db, b.id, { password: "p1", ...ENV_PW }),
    ).rejects.toThrow(/在用/);
    const kept = await updateGuestType(db, b.id, { password: "p2", ...ENV_PW });
    // 同一个口令重交一遍：内容不变（同一个摘要），只是存法保证还是摘要代
    expect(kept?.password).toMatch(/^[0-9a-f]{64}$/);
  });

  it("名称或密码为空：抛", async () => {
    const { db } = fakeDb();
    await expect(
      createGuestType(db, { name: "   ", password: "p1", ...ENV_PW }),
    ).rejects.toThrow(/名称/);
    await expect(
      createGuestType(db, { name: "x", password: "", ...ENV_PW }),
    ).rejects.toThrow(/密码/);
  });
});

describe("门口验密码", () => {
  it("命中已启用的档：返回那一档的完整行", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "合作方",
      password: "hz",
      note: "对客客气一点",
      permSearch: false,
      ...ENV_PW,
    });
    const hit = await findGuestTypeByPassword(
      db,
      "hz",
      ENV_PW.adminPw,
      ENV_PW.gatePw,
    );
    expect(hit?.id).toBe(t.id);
    expect(hit?.name).toBe("合作方");
    expect(hit?.note).toBe("对客客气一点");
    expect(hit?.permSearch).toBe(false);
  });

  it("两个内置口令不算任何一档：直接排除", async () => {
    const { db } = fakeDb();
    await createGuestType(db, { name: "合作方", password: "hz", ...ENV_PW });
    expect(
      await findGuestTypeByPassword(
        db,
        "guanli",
        ENV_PW.adminPw,
        ENV_PW.gatePw,
      ),
    ).toBeNull();
    expect(
      await findGuestTypeByPassword(
        db,
        "qiantai",
        ENV_PW.adminPw,
        ENV_PW.gatePw,
      ),
    ).toBeNull();
  });

  it("没这密码、停用的档、空口令，都不命中", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "停用档",
      password: "p1",
      ...ENV_PW,
    });
    await updateGuestType(db, t.id, { active: false, ...ENV_PW });
    expect(
      await findGuestTypeByPassword(db, "p1", ENV_PW.adminPw, ENV_PW.gatePw),
    ).toBeNull();
    expect(
      await findGuestTypeByPassword(db, "nope", ENV_PW.adminPw, ENV_PW.gatePw),
    ).toBeNull();
    expect(
      await findGuestTypeByPassword(db, "", ENV_PW.adminPw, ENV_PW.gatePw),
    ).toBeNull();
  });

  it("对外快照不带密码", async () => {
    const { db } = fakeDb();
    const t = await createGuestType(db, {
      name: "合作方",
      password: "hz",
      ...ENV_PW,
    });
    const info = toGuestTypeInfo(getGuestType(db, t.id)!);
    expect(info).toEqual({
      id: t.id,
      name: "合作方",
      note: "",
      permSearch: true,
      permDraw: true,
      permMemory: true,
      // 三项长期权益建档时缺省关：没有持久身份谈不上私人空间
      permNotes: false,
      permFiles: false,
      permPublic: false,
    });
    expect(JSON.stringify(info)).not.toContain("hz");
  });
});

describe("摘要存储与两代兼容", () => {
  it("建档后库里是摘要不是明文，门口用原口令照样进", async () => {
    const { db, rows } = fakeDb();
    await createGuestType(db, { name: "a", password: "秘密口令", ...ENV_PW });
    expect(rows[0].password).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].password).not.toContain("秘密口令");
    const hit = await findGuestTypeByPassword(
      db,
      "秘密口令",
      ENV_PW.adminPw,
      ENV_PW.gatePw,
    );
    expect(hit?.name).toBe("a");
  });

  it("老条目还是明文：门口照样验得过", async () => {
    const { db, rows } = fakeDb();
    await createGuestType(db, { name: "老档", password: "old-pw", ...ENV_PW });
    rows[0].password = "old-pw"; // 模拟摘要化之前的存量条目
    const hit = await findGuestTypeByPassword(
      db,
      "old-pw",
      ENV_PW.adminPw,
      ENV_PW.gatePw,
    );
    expect(hit?.name).toBe("老档");
  });

  it("老明文条目原样重交同一口令：就地升级成摘要", async () => {
    const { db, rows } = fakeDb();
    const t = await createGuestType(db, {
      name: "老档",
      password: "old-pw",
      ...ENV_PW,
    });
    rows[0].password = "old-pw";
    const up = await updateGuestType(db, t.id, {
      password: "old-pw",
      ...ENV_PW,
    });
    expect(up?.password).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await findGuestTypeByPassword(
        db,
        "old-pw",
        ENV_PW.adminPw,
        ENV_PW.gatePw,
      ),
    ).not.toBeNull();
  });
});

/** buildTools 用的最小假 ctx：只搭工具组注册需要的几样，execute 不会被调 */
function toolCtx(guestType: ToolCtx["guestType"], guest = true): ToolCtx {
  const { db } = fakeDb();
  return {
    env: {},
    sql: db,
    room: "guest-test",
    guest,
    guestType,
    state: { ...INITIAL_STATE, guestType },
    patchState: () => {},
  } as unknown as ToolCtx;
}

const namesOf = (ctx: ToolCtx) => Object.keys(buildTools(ctx));

describe("按档位过滤工具", () => {
  it("没带档位：全开 —— 缺省不能反着解释成全关", () => {
    const names = namesOf(toolCtx(undefined));
    expect(names).toContain("search");
    expect(names).toContain("draw");
    expect(names).toContain("memory");
    expect(names).toContain("visitor_log");
  });

  it("三个开关全关：对应工具组消失，visitor_log 与不设开关的 weather/view_image 还在", () => {
    const names = namesOf(
      toolCtx({
        id: "t1",
        name: "受限档",
        note: "",
        permSearch: false,
        permDraw: false,
        permMemory: false,
        permNotes: false,
        permFiles: false,
        permPublic: false,
      }),
    );
    expect(names).not.toContain("search");
    expect(names).not.toContain("read_url");
    expect(names).not.toContain("draw");
    expect(names).not.toContain("diagram");
    expect(names).not.toContain("memory");
    expect(names).toContain("visitor_log");
    expect(names).toContain("weather");
    expect(names).toContain("view_image");
  });

  it("失效兜底快照（票上的档位查不到/查询失败时落的这份）：六个权益全关，工具层跟着收干净", () => {
    const stub = disabledGuestTypeInfo("t-gone");
    // 兜底本身就该是全关 —— 核实不了的一档不能当成「没有约定」放行
    expect(stub.permSearch).toBe(false);
    expect(stub.permDraw).toBe(false);
    expect(stub.permMemory).toBe(false);
    expect(stub.permNotes).toBe(false);
    expect(stub.permFiles).toBe(false);
    expect(stub.permPublic).toBe(false);
    // 经工具注册层：对外工具组一个不留，留痕的还在
    const names = namesOf(toolCtx(stub));
    expect(names).not.toContain("search");
    expect(names).not.toContain("draw");
    expect(names).not.toContain("memory");
    expect(names).toContain("visitor_log");
  });

  it("只关检索：画画和记忆照常", () => {
    const names = namesOf(
      toolCtx({
        id: "t2",
        name: "只禁网",
        note: "",
        permSearch: false,
        permDraw: true,
        permMemory: true,
        permNotes: false,
        permFiles: false,
        permPublic: false,
      }),
    );
    expect(names).not.toContain("search");
    expect(names).toContain("draw");
    expect(names).toContain("memory");
  });

  it("主人那间不受档位影响：开关关了工具也全在", () => {
    const names = namesOf(
      toolCtx(
        {
          id: "t3",
          name: "x",
          note: "",
          permSearch: false,
          permDraw: false,
          permMemory: false,
          permNotes: false,
          permFiles: false,
          permPublic: false,
        },
        false,
      ),
    );
    expect(names).toContain("search");
    expect(names).toContain("draw");
    expect(names).toContain("memory");
  });
});
