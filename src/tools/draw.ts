// 画图：她看得懂图，也该能画一张出来。
//
// 为什么这条值得单开工具，而不是让模型描述一句「你可以想象成……」：
// 能看图只能算「读」，能画图才算「一起做点东西」。
//
// 这里是三条并列的路子，各管一件事：
//   draw       —— 插画、封面、配图。文生图模型出的，有质感、有情绪，但不可控。
//   diagram    —— 示意图、流程图、架构图、时序图、图表。她自己写 SVG，精确到每一根线。
//                 文生图模型画这类东西必然走形：框会歪、字会糊、箭头指向随机 ——
//                 而这些恰恰是示意图的命根子，所以两种得分开。
//   send_image —— 把云盘里已有的图发到对话里（画过的、存进记忆的）。
//                 她说「把上次那张给他看」时用；没有它，她只能凭空再画一张，
//                 而重画的从来不是同一张。
//
// 为什么不是一条工具加个 mode 参数：选错 mode 的代价是「出来的东西完全不对」。
// 拆成三条，看名字就知道该用哪条。
//
// 还有一步：画好的那张会随结果递回给她自己看一眼（见 draw 的 toModelOutput）——
// 明显不对就改一版提示词重画一次。为什么不交给「看图」工具去做：
// 图就在她手上，多一跳就多一次她忘记看的可能。
//
// draw 这条里面还分两档（见 quality 参数）：
//   默认 fast —— Workers AI 的 FLUX.2 klein。不要钱（免费额度内）、不带平台水印，日常配图够用。
//   high      —— 硅基流动的 Z-Image-Turbo（兜底 Kolors）。画日系动漫、人物立绘明显更对，
//                代价是按张付费，所以只在她判断「这回要好看」时才升档。
// 为什么这事用一个参数而不是拆成两条工具：这里选错的代价只是「多花几分钱」或「没画够美」，
// 不是「出来的东西完全不对」—— 而后者才是 draw / diagram 必须拆开的理由。

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { insertMemory, searchMemories } from "../agent/memory";
import { usage } from "../agent/usage";
import { scopedKey } from "../fileAccess";
import type { ToolCtx } from "./types";
import { loadImage, mayViewKey } from "./vision";

const IMG_URL = "https://open.bigmodel.cn/api/paas/v4/images/generations";

/**
 * 主力那条路：Workers AI 上的 FLUX.2 klein。
 *
 * 为什么把智谱从主力上撤下来：那边是「由便宜到贵依次试」，最便宜的一档
 * （cogview-3-flash）几乎每张都会先命中 —— 而它出的图正是「有点丑」的根子。
 * 智谱还默认在角上盖「AI生成」四个字，去水印得先去它家后台签免责声明。
 * FLUX 这边不带平台水印，走现成的 AI 绑定、不用另配 key，
 * 一张 1024² 约 26 neurons（¥0.008 上下），每天的免费额度先兜着。
 */
const FLUX_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

/** 兜底那条路：智谱。FLUX 不通（没绑 AI、额度耗尽、接口改版）时才轮到它 */
const ZHIPU_MODELS = ["cogview-4-250304", "cogview-3-flash"];

/**
 * 高质量档：硅基流动。国产路线，赛璐璐和二次元结构比 FLUX 正，
 * 主力用 Z-Image-Turbo（出得稳、6 秒上下），Kolors 退在后面当备胎。
 *
 * 反过来先试 Kolors 不行：它是老一代的，画风偏厚涂、细节容易糊；
 * 真到 Z-Image 不通的时候，能出一张是正事，才轮到它。
 */
const SF_URL = "https://api.siliconflow.cn/v1/images/generations";
const SF_MODELS = ["Tongyi-MAI/Z-Image-Turbo", "Kwai-Kolors/Kolors"];

/** 画幅。3:4 和 4:3 是多数模型都认的两个尺寸，方图另算。 */
const SIZES = {
  square: { w: 1024, h: 1024 },
  wide: { w: 1344, h: 768 },
  tall: { w: 768, h: 1344 },
} as const;

/** 硅基流动是另一套尺寸表：横图给它 1280x720，别把 FLUX 那组直接搬过去 */
const SF_SIZES = {
  square: "1024x1024",
  wide: "1280x720",
  tall: "768x1024",
} as const;

/** SVG 上限。示意图是「几百行」的量级；到 200KB 已经不是图，是往里塞东西了 */
const SVG_CAP = 200_000;

/** 只声明用到的部分，免得依赖生成的 Ai 类型细节（和 memory.ts 里那处同一套写法） */
interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export function drawTools(ctx: ToolCtx): ToolSet {
  // 这一轮里画了几张。用来把「不对就重画一次」卡死在一次：
  // 她对自己的图容易越看越不顺眼，不设闸的话一张配图能来回画到把整轮耗光。
  let attempts = 0;

  const draw = tool({
    description:
      "画一张有质感的图：插画、封面、配图、场景、角色。英文提示词出图更稳，" +
      "画风、构图、光线都写进去。要画「准确」的东西（流程图、架构图、坐标图、表格图）用 diagram，" +
      "这条只用来说画面。默认那档便宜够用；画日系动漫、二次元人物、立绘，或者他说要「好看点」的时候，" +
      "把 quality 提到 high，那档贵一点但明显更像样。画好后把图片地址给你，你要把那行 markdown 放进回复里，他才看得见。",
    inputSchema: z.object({
      prompt: z
        .string()
        .describe(
          "画面描述。写清主体、风格、构图、光线、色调；英文效果通常更好，也可以中英混写",
        ),
      shape: z
        .enum(["square", "wide", "tall"])
        .default("square")
        .describe("画幅：方形 / 横图 / 竖图"),
      quality: z
        .enum(["fast", "high"])
        .default("fast")
        .describe(
          "画质档。默认 fast：便宜档，日常配图、示意用图、随手画一张就用它。" +
            "画日系动漫、二次元人物、立绘、封面，或者他说「画好看点」「要能拿得出手的」，才用 high" +
            "（high 按张付费，别当默认）",
        ),
      keep: z
        .boolean()
        .optional()
        .describe(
          "true = 画完顺手把这张存进记忆（type=image）。他说「这个以后还要用」「存着」的时候才用，" +
            "别每张都存——配图不是藏品，图多了记忆库就成了图床",
        ),
    }),
    execute: async ({ prompt, shape, keep, quality }) => {
      attempts += 1;
      const { w, h } = SIZES[shape];
      const size = `${w}x${h}`;
      const errors: string[] = [];

      let bytes: ArrayBuffer | null = null;
      let meta = "";

      // 来客一律走便宜档：高质量那档花的是管理员的钱，不该由路过的人替他决定
      const tier = ctx.guest ? "fast" : quality;

      // 她点了 high 就先走贵的这档；这档没成会自动往下掉到 FLUX，不会白花一次
      if (tier === "high") {
        const hi = await siliconFlowDraw(ctx.env, prompt, shape, errors);
        if (hi) {
          bytes = hi.bytes;
          meta = hi.meta;
        }
      }
      if (!bytes) {
        try {
          bytes = await fluxDraw(ctx.env, prompt, w, h);
          meta = `FLUX.2 klein · ${size}`;
        } catch (e) {
          errors.push(`FLUX：${(e as Error).message.slice(0, 120)}`);
        }
      }
      if (!bytes) {
        const back = await zhipuDraw(ctx.env, prompt, size, errors);
        if (back) {
          bytes = back.bytes;
          meta = back.meta;
        }
      }
      if (!bytes) return "这次没画成：\n" + errors.join("\n");

      // 存进云盘再给他看：供应商给的地址有有效期，过几天他自己翻回来就是一片空白。
      // key 带房间前缀 + 随机段：来客读图靠它划界，也免得光靠时间戳就能撞名
      const key = scopedKey(ctx.room, "draw", "png");
      await ctx.env.MEMORY_BUCKET.put(key, bytes, {
        httpMetadata: { contentType: "image/png" },
      });

      const kept = keep ? keepMemory(ctx, prompt, key) : "";
      return (
        handOff(
          `画好了：/api/files/${key}`,
          prompt.slice(0, 40),
          `/api/files/${key}`,
          meta,
          kept,
        ) +
        "\n\n" +
        selfCheck(attempts)
      );
    },
    // 图递回去让她自己看一眼 —— 自检就靠这一句（下面那段注释解释为什么走这里）。
    // key 是从她自己的输出里抠的，但她写什么字不由我们定：万一被诱导写出别家的 key，
    // 递图前也得过一遍房间划界 —— 和 view_image 是同一扇门
    toModelOutput: async ({ output }) => {
      const key = imageKeyIn(output);
      const img =
        key && mayViewKey(ctx, key) ? await loadImage(ctx.env, key) : null;
      if (!img?.ok) return { type: "text", value: output };
      return {
        type: "content",
        value: [
          { type: "text", text: output },
          { type: "image-data", data: img.data, mediaType: img.mediaType },
        ],
      };
    },
  });

  const diagram = tool({
    description:
      "画一张准确的示意图：流程图、架构图、时序图、状态机、思维导图、坐标图、折线/柱状图、" +
      "结构拆解、对比表格图。你自己写 SVG 源码，我存成图片给他看 —— 每一根线、每一个字都由你摆，" +
      "所以它不会走形。要画有质感、有情绪的插画用 draw，这条只负责把结构讲清楚。",
    inputSchema: z.object({
      svg: z
        .string()
        .describe(
          "完整的 SVG 源码，从 <svg 开始到 </svg> 结束（外面别包 ``` 围栏，也别加解释）。" +
            '<svg> 上必须写 xmlns="http://www.w3.org/2000/svg" 和 viewBox（横图建议 0 0 800 500 一类，' +
            '四周留 20 左右的边距）。文字写 font-family="sans-serif" 与 font-size，别依赖外部字体；' +
            "线条用 stroke 加 stroke-width，别用外链图片和脚本。这张图会贴在深色界面上，" +
            '底色自己铺（比如先画一个 fill="#0f172a" 的 rect 铺满），字用浅色；配色两三个就够。',
        ),
      title: z
        .string()
        .describe("这张图叫什么。既是文件名，也是以后回头找它的线索"),
      keep: z
        .boolean()
        .optional()
        .describe(
          "true = 把这张示意图存进记忆（type=image）。他说「以后还要看」「存着」的时候才用",
        ),
    }),
    execute: async ({ svg, title, keep }) => {
      const clean = extractSvg(svg);
      if (!clean)
        return "这段 SVG 存不下来：我需要一段完整的 <svg …>…</svg>（从 <svg 开始，到 </svg> 结束）。";
      if (clean.length > SVG_CAP) {
        return `这张图太大了（${Math.round(clean.length / 1024)}KB），简化一下再来——示意图不该有这么多笔画。`;
      }
      const key = scopedKey(ctx.room, "diagram", "svg");
      await ctx.env.MEMORY_BUCKET.put(key, clean, {
        httpMetadata: { contentType: "image/svg+xml" },
      });
      const kept = keep ? keepMemory(ctx, title, key) : "";
      const url = `/api/files/${key}`;
      return handOff(
        `图已经画好了：${url}`,
        title,
        url,
        `SVG 示意 · ${Math.round(clean.length / 1024)}KB`,
        kept,
      );
    },
  });

  const tools: ToolSet = { draw, diagram };

  // 发图不给来客：云盘是同一只桶，他凭一个文件名就能把管理员的图翻出来
  if (ctx.guest) return tools;

  tools.send_image = tool({
    description:
      "把他要的图发到对话里。他说「把那张图给我看看」「上次画的那张呢」的时候用。" +
      "知道文件名就给完整 key（画完时我告诉过你，形如 f/default/draw-1730000000000-9f2c1eab.png）；" +
      "说不清文件名就给 query，我去图像记忆里按画面内容找 —— 但只有当时存过（keep）的图才找得回来。" +
      "无论哪条路，拿到地址后必须把那行 markdown 放进你的回复里，他才看得见。",
    inputSchema: z.object({
      key: z
        .string()
        .optional()
        .describe(
          "云盘文件名，形如 draw-1730000000000.png 或 diagram-1730000000000.svg",
        ),
      query: z
        .string()
        .optional()
        .describe(
          "想找哪张图：按画面内容去图像记忆里搜，比如「弹道示意图」「那张蓝猫」",
        ),
      note: z
        .string()
        .optional()
        .describe("配一句话说明这是什么，会写进图片的替换文字里"),
    }),
    execute: async ({ key, query, note }) => {
      const found = await findImage(ctx, key, query);
      if (!found) {
        return key?.trim()
          ? `云盘里没有这个文件：${key}`
          : "图像记忆里没找到对得上的图。要么他说的不是这个说法，要么那张图当时没存下来 —— 没存的话得重新画一张。";
      }
      const url = `/api/files/${encodeURIComponent(found.key)}`;
      const alt = note?.trim() || found.content.slice(0, 30) || "图片";
      const seen = found.content ? `这是当时存下的：${found.content}\n\n` : "";
      return `${seen}把下面这行原样放进你的回复里（别改动括号里的地址）：\n![${alt}](${url})`;
    },
  });

  return tools;
}

/**
 * 交图给模型时统一说同一套话。
 *
 * 为什么要反复叮嘱「把那行 markdown 放进回复」：图是这条工具唯一的产出，
 * 而模型很容易只回一句「画好了」，人就什么都看不见。工具卡里另有兜底渲染
 * （前端的 Drawn），但正文里那张图才是他要的位置。
 */
export function handOff(
  lead: string,
  alt: string,
  url: string,
  meta: string,
  kept: string,
): string {
  // 方括号会把那一行 markdown 本身拆散（前端是按 ![…](…) 认图的），所以替换文字里不留方括号
  const safe = alt.replace(/[[\]]/g, "");
  return (
    `${lead}\n\n` +
    `把下面这行原样放进你的回复里，他就能看到图（别改动括号里的地址）：\n` +
    `![${safe}](${url})\n\n` +
    `（${meta}）${kept}`
  );
}

/**
 * 画完让她自己看一眼。
 *
 * 这一句是自检的全部机关 —— 图已经随这条结果递回去了（见 draw 的 toModelOutput），
 * 所以这里只说「看什么、不对怎么办」。
 *
 * 为什么走 toModelOutput 而不是让她再调一次看图工具：图就在手上，多一跳就多一次
 * 她忘记看的可能；而且它只在「这一轮的下一步」生效，历史里留下的还是这行文字，
 * 图不会每一轮都重发一遍（那是白烧 token）。
 */
export function selfCheck(n: number): string {
  if (n <= 1)
    return "这张图就在下面，你自己看一眼：脸崩了、手指多出来、主体不是我要的、糊成一团，就改一版提示词再画一次（最多一次）。";
  return "这版是重画过的了，就用它：别再画第三版，把图给他，顺口说一句这版改了什么。";
}

/** 从工具结果那段文字里把云盘文件名抠回来（handOff 写进去的那个地址） */
export function imageKeyIn(text: string): string | null {
  const m = /!\[[^\]]*\]\(\/api\/files\/([^)\s]+)\)/.exec(text);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 「存着」的那张才进记忆：说明写的是画面本身（检索靠它命中），原件的指针是 key。
 * keep 是 opt-in —— 不设闸的话，画得越多记忆库越像图床，检索会被废图淹掉。
 */
function keepMemory(ctx: ToolCtx, content: string, fileKey: string): string {
  try {
    const mem = insertMemory(ctx.sql, {
      type: "image",
      content: content.slice(0, 300),
      title: "",
      fileKey,
      shelf: "knowledge",
    });
    ctx.enqueueVector({
      id: mem.id,
      content: content.slice(0, 300),
      type: "image",
      shelf: "knowledge",
      tags: mem.tags,
    });
    return `\n已存进记忆 [${mem.id}]，以后搜这段描述能找回来。`;
  } catch {
    return "\n（想顺手存进记忆，但记忆库没写成——图本身是好的，要存的话回头用 memory add 补一条。）";
  }
}

/** 她要发的那张图：给文件名就直接认，给关键词就去图像记忆里找（只认存成 image 的那些） */
async function findImage(
  ctx: ToolCtx,
  key?: string,
  query?: string,
): Promise<{ key: string; content: string } | null> {
  const k = (key || "").trim();
  if (k) {
    const obj = await ctx.env.MEMORY_BUCKET.head(k);
    return obj ? { key: k, content: "" } : null;
  }
  const q = (query || "").trim();
  if (!q) return null;
  try {
    const hits = await searchMemories(ctx.sql, ctx.env, q, 8, {
      cache: ctx.recallCache,
    });
    const hit = hits.find((e) => e.type === "image" && e.fileKey);
    if (hit) return { key: hit.fileKey, content: hit.content };
  } catch {
    // 向量检索没通不该让「发图」整条废掉：退到库里最近存的那张图像记忆
  }
  const rows = ctx.sql<{ file_key: string; content: string }>`
    SELECT file_key, content FROM memories
    WHERE type = 'image' AND file_key != '' AND superseded_by = ''
    ORDER BY learned DESC LIMIT 1`;
  const r = rows[0];
  return r ? { key: r.file_key, content: r.content } : null;
}

/**
 * 模型常常把 SVG 包在 ``` 围栏里，或者前后带一句「这是源码」——
 * 这里只取 <svg …>…</svg> 那一段，其余一概不要。
 */
export function extractSvg(raw: string): string | null {
  const start = raw.indexOf("<svg");
  const end = raw.lastIndexOf("</svg>");
  if (start < 0 || end < 0 || end < start) return null;
  return raw.slice(start, end + "</svg>".length);
}

// ── 出图的三条路（便宜档 / 高质量档 / 兜底）─────────────

/**
 * 主力：Workers AI 上的 FLUX.2 klein。
 *
 * 这家模型的入参是 multipart 表单，不是 JSON —— prompt 和尺寸都得当字段塞进去，
 * 所以不能直接 fetch，得把 FormData 包成 Response 再取 body 交给 run。
 * 回的是 base64（不是地址），省了一次下载。
 */
async function fluxDraw(
  env: Env,
  prompt: string,
  w: number,
  h: number,
): Promise<ArrayBuffer> {
  const ai = env.AI as unknown as AiRunner | undefined;
  if (!ai) throw new Error("没绑 Workers AI");

  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(w));
  form.append("height", String(h));
  const wrapped = new Response(form);

  const out = (await ai.run(FLUX_MODEL, {
    multipart: {
      body: wrapped.body,
      contentType: wrapped.headers.get("content-type") || "multipart/form-data",
    },
  })) as { image?: string };
  if (!out?.image) throw new Error("回里没有图");
  // 成了才记账：烧的是 CF 的 neurons 额度（见 usage.ts），失败的那几次不算
  usage.noteFluxImage(w, h);
  return fromBase64(out.image);
}

/**
 * 高质量档：硅基流动。
 *
 * 它回的是图片地址（不是 base64），而且地址是他们的临时桶、一小时就过期，
 * 所以必须当场下下来存进自己的云盘 —— 这也正是下面那段 fetchImage 的活。
 *
 * 为什么失败不直接报错、而是往下掉到 FLUX：她已经挑了「要好看的」这一档，
 * 这时候交出一张普通档的图，比交出一句「没画成」有用得多。
 */
async function siliconFlowDraw(
  env: Env,
  prompt: string,
  shape: keyof typeof SF_SIZES,
  errors: string[],
): Promise<{ bytes: ArrayBuffer; meta: string } | null> {
  const apiKey = env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    errors.push("硅基流动：SILICONFLOW_API_KEY 没配");
    return null;
  }
  const size = SF_SIZES[shape];
  for (const model of SF_MODELS) {
    try {
      const r = await fetch(SF_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({
          model,
          prompt,
          image_size: size,
          batch_size: 1,
        }),
      });
      if (!r.ok) {
        errors.push(
          `${model}：HTTP ${r.status} ${(await r.text()).slice(0, 120)}`,
        );
        continue;
      }
      const j = (await r.json()) as { images?: Array<{ url?: unknown }> };
      const bytes = await fetchImage(j.images?.[0]?.url, undefined);
      if (!bytes) {
        errors.push(`${model}：没拿到图`);
        continue;
      }
      // 标出「哪家 + 硅基流动」，和默认那档的 FLUX.2 klein 一眼分得开
      return { bytes, meta: `${model.split("/").pop()} · 硅基流动 · ${size}` };
    } catch (e) {
      errors.push(`${model}：${(e as Error).message.slice(0, 120)}`);
    }
  }
  return null;
}

/**
 * 兜底：智谱。FLUX 那边不通时才走这里，所以顺序上「好一点的先试」——
 * 都到兜底了，质量比省那几分钱要紧。
 */
async function zhipuDraw(
  env: Env,
  prompt: string,
  size: string,
  errors: string[],
): Promise<{ bytes: ArrayBuffer; meta: string } | null> {
  const apiKey = env.ZHIPU_KEY;
  if (!apiKey) {
    errors.push("智谱：ZHIPU_KEY 没配");
    return null;
  }
  for (const model of ZHIPU_MODELS) {
    try {
      const r = await fetch(IMG_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({ model, prompt, size }),
      });
      if (!r.ok) {
        errors.push(
          `${model}：HTTP ${r.status} ${(await r.text()).slice(0, 120)}`,
        );
        continue;
      }
      const j = (await r.json()) as {
        data?: Array<{ url?: unknown; b64_json?: unknown }>;
      };
      const first = j.data?.[0];
      const bytes = first ? await fetchImage(first.url, first.b64_json) : null;
      if (!bytes) {
        errors.push(`${model}：没拿到图`);
        continue;
      }
      return { bytes, meta: `${model} · ${size}` };
    } catch (e) {
      errors.push(`${model}：${(e as Error).message.slice(0, 120)}`);
    }
  }
  return null;
}

/** base64 → 字节。Worker 里没有 Buffer，只能一个字符一个码地还回去 */
function fromBase64(b64: string): ArrayBuffer {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

/** 供应商可能回一个临时地址，也可能直接回 base64；两种都接住 */
async function fetchImage(
  url: unknown,
  b64: unknown,
): Promise<ArrayBuffer | null> {
  if (typeof url === "string" && url) {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    return buf.byteLength ? buf : null;
  }
  if (typeof b64 === "string" && b64) return fromBase64(b64);
  return null;
}
