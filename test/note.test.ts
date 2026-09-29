/**
 * 笔记本测试。
 *
 * 这里测的是「本子本身」—— 存取、排序、搜索、版本。语义那一半（她该不该改写、怎么改写）
 * 归模型，测不了也不该测。
 *
 * fakeSql 直接把两张表读写在内存里（而不是只记语句）：
 * 这一层的 bug 基本都在「排出来的顺序」「改了几次之后还剩几版」「删掉之后有没有留孤儿」
 * 这类地方，只断言「发过什么 SQL」是看不见这些的。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import {
  NOTE_CAP,
  NOTE_FOCUS_CHARS,
  NOTE_PREVIEW,
  NOTE_REV_KEEP,
  deleteNote,
  deriveTitle,
  getNote,
  listNotes,
  listRevisions,
  newNoteId,
  noteFocusBlock,
  restoreRevision,
  saveNote,
} from "../src/agent/noteStore";
import type { SqlTag } from "../src/agent/state";

interface Row {
  id: string;
  title: string;
  body: string;
  tags: string;
  author: string;
  updated_by: string;
  pinned: number;
  created: string;
  updated: string;
}

interface RevRow {
  note_id: string;
  seq: number;
  title: string;
  body: string;
  saved_at: string;
  by: string;
}

const iso = (n: number) =>
  new Date(Date.UTC(2026, 8, 1 + n, 10, 0, 0)).toISOString();

const row = (
  id: string,
  title: string,
  updated: string,
  patch: Partial<Row> = {},
): Row => ({
  id,
  title,
  body: "",
  tags: "",
  author: "user",
  updated_by: "user",
  pinned: 0,
  created: updated,
  updated,
  ...patch,
});

const NOTES_COLS =
  "SELECT id, title, body, tags, author, updated_by, pinned, created, updated FROM notes";

/**
 * 一张内存里的 notes + note_revisions。
 * 只认本层真会发的那些语句，不做通用 SQL 解析 —— 把真 SQLite 搬进来，
 * 测的就成了「我 SQL 写得对不对」，而不是「这一层的规矩对不对」。
 * 认不出来的语句直接抛错并把原句带上：悄悄返回空数组最危险，
 * 那会让「查询本身错」长得和「查出来就是没有」一模一样。
 */
function makeDb(seed: Row[] = [], revSeed: RevRow[] = []) {
  const rows = seed.map((r) => ({ ...r }));
  const revs = revSeed.map((r) => ({ ...r }));

  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();

    if (q.startsWith("CREATE")) return [] as never;

    if (q.startsWith("SELECT COUNT(*)")) return [{ n: rows.length }] as never;

    if (q.startsWith("SELECT MAX(seq)")) {
      const id = String(values[0]);
      const own = revs.filter((r) => r.note_id === id).map((r) => r.seq);
      return [{ s: own.length ? Math.max(...own) : null }] as never;
    }

    if (q.startsWith("INSERT INTO note_revisions")) {
      const [note_id, seq, title, body, saved_at, by] = values as [
        string,
        number,
        string,
        string,
        string,
        string,
      ];
      revs.push({ note_id, seq, title, body, saved_at, by });
      return [] as never;
    }

    if (q.startsWith("INSERT INTO notes")) {
      const [
        id,
        title,
        body,
        tags,
        author,
        updated_by,
        pinned,
        created,
        updated,
      ] = values as string[];
      rows.push({
        id,
        title,
        body,
        tags,
        author,
        updated_by,
        pinned: Number(pinned),
        created,
        updated,
      });
      return [] as never;
    }

    if (q.startsWith("UPDATE notes SET")) {
      const [title, body, tags, updated_by, pinned, updated, id] = values as [
        string,
        string,
        string,
        string,
        number,
        string,
        string,
      ];
      const r = rows.find((x) => x.id === id);
      if (r) {
        r.title = title;
        r.body = body;
        r.tags = tags;
        r.updated_by = updated_by;
        r.pinned = Number(pinned);
        r.updated = updated;
      }
      return [] as never;
    }

    if (q.startsWith("DELETE FROM note_revisions")) {
      const id = String(values[0]);
      // 两副样子：删某一篇的全部历史 / 裁掉超出保留数的那些
      const cut = q.includes("seq <= ?") ? Number(values[1]) : Infinity;
      for (let i = revs.length - 1; i >= 0; i--) {
        if (revs[i].note_id === id && revs[i].seq <= cut) revs.splice(i, 1);
      }
      return [] as never;
    }

    if (q.startsWith("DELETE FROM notes")) {
      const id = String(values[0]);
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return [] as never;
    }

    if (q.startsWith("SELECT title, body FROM note_revisions")) {
      const [id, seq] = values as [string, number];
      return revs
        .filter((r) => r.note_id === id && r.seq === seq)
        .map((r) => ({ title: r.title, body: r.body })) as never;
    }

    if (
      q.startsWith(
        "SELECT note_id, seq, title, body, saved_at, by FROM note_revisions",
      )
    ) {
      const [noteId, limit] = values as [string, number];
      return revs
        .filter((r) => r.note_id === noteId)
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit)
        .map((r) => ({ ...r })) as never;
    }

    // notes 的两条读：按 id 单取，和列表（四种条件各一条固定语句）
    if (q.startsWith(NOTES_COLS)) {
      const rest = q.slice(NOTES_COLS.length);

      if (rest.startsWith(" WHERE id = ?")) {
        const id = String(values[0]);
        return rows.filter((r) => r.id === id).map((r) => ({ ...r })) as never;
      }

      const byQ = rest.includes("title LIKE ?");
      const byTag = rest.includes("tags || ','");
      // 四种条件对应的绑定值形状（这是这一层唯一要记住的东西）：
      //   只有 q   → [like, like, limit]   两条 LIKE 各绑一次
      //   只有 tag → [t, limit]
      //   两者都有 → [like, like, t, limit]
      //   都没有   → [limit]
      // 按「一个条件一个值」去数会少算一次，limit 就落到 NaN 上 ——
      // slice(0, NaN) 不报错、只返回空，看着活像「搜不到」，最难查。
      const limit = Number(values[values.length - 1] ?? NOTE_CAP);
      const like = byQ ? String(values[0]) : "";
      const t = byTag ? String(values[byQ ? 2 : 0]) : "";
      const keyword = like.slice(1, -1);
      const tagName = t.slice(2, -2);
      return rows
        .filter(
          (r) =>
            (!byQ || r.title.includes(keyword) || r.body.includes(keyword)) &&
            (!byTag || `,${r.tags},`.includes(`,${tagName},`)),
        )
        .sort(
          (a, b) => b.pinned - a.pinned || b.updated.localeCompare(a.updated),
        )
        .slice(0, limit)
        .map((r) => ({ ...r })) as never;
    }

    throw new Error(`假的 sql 没认出这条语句：${q}`);
  };

  return { sql: tag as unknown as SqlTag, rows, revs };
}

describe("newNoteId / deriveTitle", () => {
  it("id 以 n 开头（和记忆的 m、承诺的 p 分开，三边的 id 不会混）", () => {
    expect(newNoteId().startsWith("n")).toBe(true);
  });

  it("连着取不会撞", () => {
    expect(new Set(Array.from({ length: 50 }, () => newNoteId())).size).toBe(
      50,
    );
  });

  it("标题留空时取正文第一行，井号也算数", () => {
    expect(deriveTitle("# 装修清单\n\n先定地板")).toBe("装修清单");
    expect(deriveTitle("\n\n  直接就是一句  \n后面还有")).toBe("直接就是一句");
  });

  it("正文也空着时给个「未命名」，不留一篇没名字的", () => {
    expect(deriveTitle("")).toBe("未命名");
    expect(deriveTitle("\n\n")).toBe("未命名");
  });
});

describe("新建与改写", () => {
  it("新建的一篇：作者记账分得开，标题能自动取", () => {
    const { sql } = makeDb();
    const n = saveNote(sql, { body: "# 房间改造\n先拆柜子", by: "user" });
    expect(n.author).toBe("user");
    expect(n.updatedBy).toBe("user");
    expect(n.title).toBe("房间改造");
    expect(getNote(sql, n.id)?.body).toContain("先拆柜子");
  });

  it("我动笔的那次，笔迹记成我 —— 列表里要能看出是她改的", () => {
    const { sql } = makeDb();
    const n = saveNote(sql, { title: "存一下", body: "原话", by: "user" });
    const after = saveNote(sql, { id: n.id, body: "我整理过的", by: "assistant" });
    expect(after.author).toBe("user");
    expect(after.updatedBy).toBe("assistant");
  });

  it("存量助手笔迹无需改写数据库，读取时归一且新改动使用中性标记", () => {
    const legacy = "legacy-assistant-tag";
    const { sql, rows } = makeDb(
      [row("old", "旧稿", iso(0), { author: legacy, updated_by: legacy })],
      [
        {
          note_id: "old",
          seq: 1,
          title: "旧稿",
          body: "先前版本",
          saved_at: iso(0),
          by: legacy,
        },
      ],
    );
    expect(getNote(sql, "old")?.author).toBe("assistant");
    expect(listNotes(sql)[0].updatedBy).toBe("assistant");
    expect(listRevisions(sql, "old")[0].by).toBe("assistant");
    expect(rows[0].author).toBe(legacy); // 读取兼容，不在升级时覆写原始数据
    saveNote(sql, { id: "old", body: "新版", by: "assistant" });
    expect(rows[0].updated_by).toBe("assistant");
  });

  it("标签去重、去空格、逗号分隔落库", () => {
    const { sql } = makeDb();
    const n = saveNote(sql, {
      title: "t",
      body: "b",
      tags: [" 写作 ", "写作", "待整理"],
      by: "user",
    });
    expect(n.tags).toEqual(["写作", "待整理"]);
  });

  it("给一个不存在的 id 时抛错，不悄悄新建一篇", () => {
    const { sql } = makeDb();
    expect(() => saveNote(sql, { id: "n404", body: "x", by: "user" })).toThrow(
      "n404",
    );
  });

  it("钉一下不该留下一版：只有标题或正文真变了才压旧版", () => {
    const { sql } = makeDb();
    const n = saveNote(sql, { title: "t", body: "b", by: "user" });
    saveNote(sql, { id: n.id, pinned: true, by: "user" });
    expect(listRevisions(sql, n.id)).toHaveLength(0);
    expect(getNote(sql, n.id)?.pinned).toBe(true);
  });

  it("塞满到上限之后不再新建（一本几百篇之后他就找不到在写的那几篇了）", () => {
    const { sql } = makeDb(
      Array.from({ length: NOTE_CAP }, (_, i) =>
        row(`n${i}`, `第 ${i} 篇`, iso(0)),
      ),
    );
    expect(() =>
      saveNote(sql, { title: "再一篇", body: "", by: "user" }),
    ).toThrow(String(NOTE_CAP));
  });
});

describe("版本：覆盖式改写的后悔药", () => {
  it("正文变了才压旧版，压的是「改之前」的样子", () => {
    const { sql } = makeDb();
    const n = saveNote(sql, { title: "原稿", body: "第一版", by: "user" });
    saveNote(sql, { id: n.id, body: "第二版", by: "assistant" });
    const revs = listRevisions(sql, n.id);
    expect(revs).toHaveLength(1);
    expect(revs[0].body).toBe("第一版");
    expect(revs[0].title).toBe("原稿");
    expect(revs[0].by).toBe("assistant");
  });

  it("只留最近十版，更老的自己掉出去", () => {
    const { sql } = makeDb();
    const n = saveNote(sql, { title: "长跑", body: "第 0 版", by: "user" });
    for (let i = 1; i <= 12; i++)
      saveNote(sql, { id: n.id, body: `第 ${i} 版`, by: "user" });
    const revs = listRevisions(sql, n.id);
    expect(revs).toHaveLength(NOTE_REV_KEEP);
    // 最新那一版是「第 11 版」（第 12 版是现在正挂着的正文，还没被拍成历史）
    expect(revs[0].body).toBe("第 11 版");
    expect(revs[revs.length - 1].body).toBe("第 2 版");
  });

  it("退回去之后还能再退回来 —— 退回本身也走 saveNote", () => {
    const { sql } = makeDb();
    const n = saveNote(sql, { title: "稿子", body: "第一版", by: "user" });
    saveNote(sql, { id: n.id, body: "第二版", by: "assistant" });

    const back = restoreRevision(sql, n.id, 1, "user");
    expect(back?.body).toBe("第一版");
    // 「第二版」也被留成了历史，所以刚才那一下不是又一次不可逆的覆盖
    const revs = listRevisions(sql, n.id);
    expect(revs.map((r) => r.body)).toEqual(["第二版", "第一版"]);

    const again = restoreRevision(sql, n.id, revs[0].seq, "user");
    expect(again?.body).toBe("第二版");
  });

  it("退一个不存在的版本号：返回 null，原文不动", () => {
    const { sql } = makeDb();
    const n = saveNote(sql, { title: "稿子", body: "就这样", by: "user" });
    expect(restoreRevision(sql, n.id, 99, "user")).toBeNull();
    expect(getNote(sql, n.id)?.body).toBe("就这样");
  });
});

describe("删一篇", () => {
  it("连它的历史版本一起清掉，不留孤儿", () => {
    const { sql, revs } = makeDb();
    const n = saveNote(sql, { title: "短命的", body: "一", by: "user" });
    saveNote(sql, { id: n.id, body: "二", by: "user" });
    expect(revs).toHaveLength(1);

    expect(deleteNote(sql, n.id)).toBe(true);
    expect(getNote(sql, n.id)).toBeNull();
    expect(listRevisions(sql, n.id)).toHaveLength(0);
  });

  it("再删一次返回 false（已经没了，不是删成功）", () => {
    const { sql } = makeDb();
    const n = saveNote(sql, { title: "t", body: "b", by: "user" });
    expect(deleteNote(sql, n.id)).toBe(true);
    expect(deleteNote(sql, n.id)).toBe(false);
  });
});

describe("列表：顺序、搜索、标签", () => {
  it("钉住的在最前，其余按最近动过排", () => {
    const { sql } = makeDb([
      row("n1", "老的", iso(1)),
      row("n2", "新的", iso(5)),
      row("n3", "钉住的但很老", iso(0), { pinned: 1 }),
    ]);
    expect(listNotes(sql).map((n) => n.id)).toEqual(["n3", "n2", "n1"]);
  });

  it("搜标题或正文都算命中", () => {
    const { sql } = makeDb([
      row("n1", "房间改造", iso(2)),
      row("n2", "装修笔记", iso(1), { body: "顺带把房间改造的柜子量了" }),
      row("n3", "无关的", iso(0)),
    ]);
    expect(listNotes(sql, { q: "房间改造" }).map((n) => n.id)).toEqual([
      "n1",
      "n2",
    ]);
  });

  it("标签是整段匹配：「写作」不该把「写作练习」也算进来", () => {
    const { sql } = makeDb([
      row("n1", "正主", iso(2), { tags: "写作,待整理" }),
      row("n2", "擦边的", iso(1), { tags: "写作练习" }),
    ]);
    expect(listNotes(sql, { tag: "写作" }).map((n) => n.id)).toEqual(["n1"]);
  });

  it("搜索和标签同时给的时候两个条件都要成立", () => {
    const { sql } = makeDb([
      row("n1", "房间改造", iso(2), { tags: "装修" }),
      row("n2", "房间改造杂记", iso(3), { tags: "随笔" }),
      row("n3", "别的装修活", iso(4), { tags: "装修" }),
    ]);
    expect(
      listNotes(sql, { q: "房间改造", tag: "装修" }).map((n) => n.id),
    ).toEqual(["n1"]);
  });

  it("列表只带一小段开头，不把整篇正文拉进来", () => {
    const { sql } = makeDb();
    saveNote(sql, {
      title: "长文",
      body: "一".repeat(NOTE_PREVIEW + 200) + "\n第二行",
      by: "user",
    });
    expect(listNotes(sql)[0].preview).toHaveLength(NOTE_PREVIEW);
  });
});

describe("noteFocusBlock（她此刻看得到什么）", () => {
  it("没在看任何一篇 → 这段整块不出现", () => {
    const { sql } = makeDb();
    expect(noteFocusBlock(sql, "")).toBe("");
  });

  it("看的那篇已经被删了 → 同样不出现（否则我下一句就会去说一篇不存在的东西）", () => {
    const { sql } = makeDb();
    expect(noteFocusBlock(sql, "n404")).toBe("");
  });

  it("在看的那篇：标题、标签、正文开头和「他指的是哪篇」都说清", () => {
    const { sql } = makeDb();
    const n = saveNote(sql, {
      title: "房间改造",
      body: "# 先拆柜子\n再定地板",
      tags: ["装修"],
      by: "user",
    });
    const block = noteFocusBlock(sql, n.id);
    expect(block).toContain("用户正在看的笔记");
    expect(block).toContain("房间改造");
    expect(block).toContain("装修");
    expect(block).toContain("先拆柜子");
    expect(block).toContain("「这篇」指的多半就是它");
  });

  it("长文只带开头，并说明要看全得用 read —— 全文每轮顶进来太贵", () => {
    const { sql } = makeDb();
    const n = saveNote(sql, {
      title: "长文",
      body: "一".repeat(NOTE_FOCUS_CHARS + 500),
      by: "user",
    });
    const block = noteFocusBlock(sql, n.id);
    expect(block).not.toContain("一".repeat(NOTE_FOCUS_CHARS + 1));
    expect(block).toContain("后面还有");
  });

  it("空着的一篇也说一句，别让我以为它坏了", () => {
    const { sql } = makeDb();
    const n = saveNote(sql, { title: "刚起的", body: "", by: "user" });
    expect(noteFocusBlock(sql, n.id)).toContain("这篇还空着");
  });
});
