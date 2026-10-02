// 点开看大图。
//
// 为什么走 window 上的一个自定义事件，而不是把回调一层层往下传：
// 图出现在三个地方（正文里的 markdown、工具卡里的 Drawn、记忆面板的缩略图），
// 而正文那个 Markdown 是 memo 过的 —— 每来一个 chunk 都可能重渲，
// 传进去的回调一旦换身份，memo 就白做了（整场历史都要重新解析一遍）。
// 事件是模块级的：谁看见图谁喊一声，不需要谁记得往下传，也不牵动渲染。

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";
import { Icon } from "./Icons";
import "./Lightbox.css";

const ZOOM_EVENT = "ericher:zoom";

/**
 * 看图链路的诊断痕迹。
 *
 * 为什么常开、而不是藏在某个开关后面：这条链路已经黑了好几轮 —— 三级降级每级
 * 为什么倒、量到的宽是多少、取源回来什么状态码，全都无声无息，出了问题只剩猜。
 * 留痕的成本是几行 console，收益是下次复现时一眼看见断在哪一级。
 * 前缀固定成「[看图]」，F12 里一搜就是一整条轨迹。
 */
function trace(step: string, data?: Record<string, unknown>) {
  console.warn("[看图]", step, data ?? "");
}

/** 地址只留半截：失败兜底里绝不倾倒整条大地址，云盘 key 更是要截短 */
function brief(src: string): string {
  if (!src) return "(空)";
  if (src.startsWith("blob:")) return "blob:…";
  if (src.startsWith("data:")) return `data:…(${src.length}字)`;
  const tail = src.split("/").pop() || src;
  return tail.length > 48 ? `${tail.slice(0, 48)}…` : tail;
}

/**
 * 任何地方看见一张能看的图，都调它放大。
 * src 是能直接当 <img>/链接用的地址；inlineSvg 是一段 SVG 源码 —— mermaid 的图
 * 带着 HTML 标签（foreignObject），塞进 <img>（无论 data: 还是 blob:）都渲染不了，
 * 只能像正文里那样原地内联注入。
 */
export function zoomIn(src: string, alt: string, inlineSvg = "") {
  if (!src && !inlineSvg) return;
  window.dispatchEvent(
    new CustomEvent(ZOOM_EVENT, { detail: { src, alt, inlineSvg } }),
  );
}

/**
 * 换图 / 关图时把 blob 地址放掉 —— mermaid 大图的 blob 是真占内存的字节引用，
 * 不像 data: 只是一串字符。其它地址原样放行。
 */
function dropPic(p: { src: string; alt: string; inlineSvg?: string } | null) {
  if (p && p.src.startsWith("blob:")) URL.revokeObjectURL(p.src);
  return null;
}

/**
 * 一张图当前的看法。
 *
 * s 是「这张图被画成多大」—— 相对它自己固有尺寸的真实比率，1 就是原尺寸。
 * 关键在 s 不是 transform 里的 scale，而是直接写进宽度的：图是矢量的，按目标尺寸
 * 重新布局，浏览器才会按目标精度重画那几块看得见的瓦片；用 transform 拉伸的是一张
 * 已经栅格化的层，长图（这张有 5000+ px 高）一拉就糊。
 * x/y 是位移，单位就是屏幕像素，写在 translate 里 —— 平移不改尺寸，不重排，
 * 整件事落在合成器上。
 */
type View = { s: number; x: number; y: number };

/** 一张图的固有尺寸（它自己的自然单位）。量出来之前不知道要铺多大。 */
type Size = { w: number; h: number };

/** 画布此刻的位置与大小 —— 所有屏幕坐标↔图内坐标的换算都以它为基准 */
type Frame = { left: number; top: number; w: number; h: number };

/** 下限够把长图整幅缩进一屏，上限够把 157 行的大图逐字读清 */
const S_MIN = 0.02;
const S_MAX = 8;
const ZOOM_STEP = 1.35;
/** 小图按屏宽铺会被放大到没法看，给「固有宽 × 1.6」当天花板 */
const FIT_CEIL = 1.6;

function clampScale(s: number) {
  return Math.min(S_MAX, Math.max(S_MIN, s));
}

/**
 * 位移的夹取：装得下就居中，装不下就贴边滚（拖到头就停下）。
 * 顺带保证图永远不会被甩出画面 —— 手一滑看不见图，比缩放错了更难受。
 */
function clampView(v: View, nat: Size, frame: Frame): View {
  const w = nat.w * v.s;
  const h = nat.h * v.s;
  const x =
    w <= frame.w ? (frame.w - w) / 2 : Math.min(0, Math.max(frame.w - w, v.x));
  const y =
    h <= frame.h ? (frame.h - h) / 2 : Math.min(0, Math.max(frame.h - h, v.y));
  return { s: v.s, x, y };
}

/**
 * 合开启视角：铺满可用宽、从图的开头看起。
 * 内联流程图不拿屏高卡 —— 又高又瘦的图按屏高缩会缩成一条；位图要卡，一张照片
 * 不该顶破屏幕。上限 1.6 倍固有宽是给三五个节点的小图的。
 */
function fitView(nat: Size, frame: Frame, isSvg: boolean): View {
  const byW = frame.w / nat.w;
  const s = clampScale(
    isSvg ? Math.min(byW, FIT_CEIL) : Math.min(1, byW, frame.h / nat.h),
  );
  return clampView({ s, x: 0, y: 0 }, nat, frame);
}

/**
 * 以光标为锚点缩放 —— 滚轮和捏合走这条，不然一放大图就从眼皮底下溜走。
 *
 * 变换里没有 scale（图多大由宽度说了算），所以屏幕坐标换算回图内只是一次减法：
 * 图内自然坐标 u = (光标 - 画面原点 - 位移) / s。要让光标底下那个点缩放前后不动：
 *   frame.left + x' + u·s' = 光标   →   x' = x + u·(s - s')
 * 纵向同理。算完过一遍夹取，贴边时会有轻微偏移，那正是「到头了」该有的表现。
 */
function zoomAt(
  v: View,
  clientX: number,
  clientY: number,
  frame: Frame,
  nat: Size,
  k: number,
): View {
  const s = clampScale(v.s * k);
  if (s === v.s) return v;
  const u = (clientX - frame.left - v.x) / v.s;
  const w = (clientY - frame.top - v.y) / v.s;
  return clampView(
    { s, x: v.x + u * (v.s - s), y: v.y + w * (v.s - s) },
    nat,
    frame,
  );
}

/** 绕画面中心缩放：眼睛盯着的那一块不动。按钮和双击走这条 */
function zoomTo(v: View, frame: Frame, nat: Size, k: number): View {
  return zoomAt(
    v,
    frame.left + frame.w / 2,
    frame.top + frame.h / 2,
    frame,
    nat,
    k,
  );
}

/**
 * 铺满一屏的看图层。顶部工具条上是「缩小 / 百分比 / 放大 / 下载原图 / 新窗口打开 / 关掉」，
 * Esc 或点空白处也能关 —— 看图的时候手最不想离开键盘。
 *
 * 缩放不是把图拉大，而是改图的宽度：s 直接写成 svg 的 CSS 宽度（固有宽 × s），
 * 矢量按目标尺寸重排重画，放到几倍都是锐的；位移单独走 translate，不重排。
 * 滚轮和捏合以光标为锚点（zoomAt），按钮和双击绕画面中心（zoomTo），
 * 一指按住拖动平移。百分比是真实比率（1 = 原尺寸），点一下在「适配屏幕」和
 * 「原尺寸 100%」之间来回。连续滚轮/捏合会重排，所以同一帧里合成一次再落。
 *
 * 打开一张图走的是三级台阶，哪级立得住就停在哪级：
 *  1. auto：有 SVG 源码就原地内联注入（和正文里那张同一份 DOM）；注入后量一量，
 *     svg 没立起来（0 宽，flex 容器里 width=100% 会塌缩）就降到下一级
 *  2. img：位图直接摆；.svg 文件加载失败时把源文件取回来转内联再试一次（旧图走这条）
 *  3. miss：全走完还不行，给人话和一条「在新窗口打开」的活路，不玩失踪
 */
export function Lightbox() {
  const [pic, setPic] = useState<{
    src: string;
    alt: string;
    inlineSvg?: string;
  } | null>(null);
  const [mode, setMode] = useState<"auto" | "img" | "miss">("auto");
  const svgBox = useRef<HTMLDivElement | null>(null);
  // 内联验收连续塌缩后，把 svg 自带的 max-width 掰过来再量一次
  const [forcing, setForcing] = useState(false);
  const tries = useRef(0);

  // —— 缩放与平移 ——
  // s=0 是「还没量出固有尺寸」：先由 CSS 给的兜底宽把图立起来，量到了再定视角
  const [view, setView] = useState<View>({ s: 0, x: 0, y: 0 });
  const [nat, setNat] = useState<Size | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  // 多指缩放要盯着几根手指：按住的那几根、起手的指距与倍数
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  const pinchFrom = useRef<{ d: number; s: number } | null>(null);
  const panFrom = useRef<{ x: number; y: number } | null>(null);
  // 拖过就不要再当「点空白关图」——不然松手那一下顺手把图关了
  const dragged = useRef(false);
  // 渲染期同步一份最新视角：pointerdown 起手时要读它，那时闭包里的 view 可能旧一帧
  const viewRef = useRef(view);
  viewRef.current = view;
  // 缩放一步会重排整张图，同一帧里连着来的滚轮/捏合合成一次再落
  const pending = useRef<((v: View) => View) | null>(null);
  const raf = useRef(0);

  /** 画布此刻的位置与大小。每步都可能改布局，所以都是现量 */
  const frameNow = (): Frame | null => {
    const r = viewport.current?.getBoundingClientRect();
    return r ? { left: r.left, top: r.top, w: r.width, h: r.height } : null;
  };

  const queue = (f: (v: View) => View) => {
    const prev = pending.current;
    pending.current = prev ? (v) => f(prev(v)) : f;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const run = pending.current;
      pending.current = null;
      if (run) setView(run);
    });
  };

  /** 量到一张图的固有尺寸：定下合开启的视角 */
  const adopt = (size: Size, isSvg: boolean) => {
    const frame = frameNow();
    if (!frame || !size.w || !size.h) return;
    trace("量到固有尺寸", {
      宽: Math.round(size.w),
      高: Math.round(size.h),
      画面: `${Math.round(frame.w)}×${Math.round(frame.h)}`,
      合开启的倍数: Math.round(fitView(size, frame, isSvg).s * 100) + "%",
    });
    setNat(size);
    setView(fitView(size, frame, isSvg));
  };

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  /** 百分比按钮：在「适配屏幕」和「原尺寸 100%」之间来回 —— 数字是真实的，点它为了看真身 */
  const toggleSize = () => {
    const f = frameNow();
    if (!f || !nat) return;
    const isSvg = !!pic?.inlineSvg;
    setView((v) =>
      Math.abs(v.s - fitView(nat, f, isSvg).s) < 0.01
        ? clampView({ s: 1, x: v.x, y: v.y }, nat, f)
        : fitView(nat, f, isSvg),
    );
  };

  useEffect(() => {
    const onZoom = (e: Event) => {
      const next = (
        e as CustomEvent<{ src: string; alt: string; inlineSvg?: string }>
      ).detail;
      // 内联 SVG 没带地址：当场造一个 blob 给下载/新窗口用（关图时随 dropPic 回收）
      const src =
        next.src ||
        (next.inlineSvg
          ? URL.createObjectURL(
              new Blob([next.inlineSvg], { type: "image/svg+xml" }),
            )
          : "");
      trace("收到看图请求", {
        来源: next.src ? brief(next.src) : "内联 SVG",
        内联源码长度: next.inlineSvg?.length ?? 0,
        标题: next.alt,
        造出的地址: brief(src),
      });
      // 连开两张时先放掉前一张的 blob，再换上去
      setPic((prev) => {
        dropPic(prev);
        return { ...next, src };
      });
      setMode("auto");
      setForcing(false);
      tries.current = 0;
      // 新开一张图从头看起：旧的固有尺寸、视角、还没落下的那一帧都不要了
      pending.current = null;
      setNat(null);
      setView({ s: 0, x: 0, y: 0 });
    };
    window.addEventListener(ZOOM_EVENT, onZoom);
    return () => window.removeEventListener(ZOOM_EVENT, onZoom);
  }, []);

  useEffect(() => {
    if (!pic) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // preventDefault 是「认领」：App 上那个全局 Esc 听着「别说了」，
        // 看图层的这下手势得先声明是我的，不然关个图就把生成轮砍了
        e.preventDefault();
        setPic(dropPic);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pic]);

  /**
   * 滚轮缩放。为什么非得自己挂 addEventListener：React 把 wheel 挂成被动监听，
   * 里头 preventDefault 是不作数的 —— 不拦住，滚轮会连页面一起滚。
   */
  useEffect(() => {
    const el = viewport.current;
    if (!el || !pic || mode === "miss" || !nat) return;
    const size = nat;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const frame = frameNow();
      if (!frame) return;
      // deltaMode=1 是「几行」不是「几像素」，按行滚的鼠标得放大步长才跟得上
      const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
      queue((v) => zoomAt(v, e.clientX, e.clientY, frame, size, k));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pic, mode, nat]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.current.size === 1) {
      dragged.current = false;
      panFrom.current = { x: e.clientX, y: e.clientY };
    } else {
      // 第二根手指一落，平移让位给缩放
      panFrom.current = null;
      const [a, b] = [...fingers.current.values()];
      pinchFrom.current = {
        d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        s: viewRef.current.s,
      };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const at = fingers.current.get(e.pointerId);
    if (!at || !nat) return;
    at.x = e.clientX;
    at.y = e.clientY;
    const size = nat;
    const frame = frameNow();
    if (!frame) return;

    if (fingers.current.size >= 2 && pinchFrom.current) {
      const [a, b] = [...fingers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      // 目标倍数 = 起手倍数 × 指距比；换成「相对当前」的系数交给 zoomAt
      const from = pinchFrom.current;
      queue((v) =>
        zoomAt(v, mx, my, frame, size, (from.s * (d / from.d)) / v.s),
      );
      return;
    }

    const from = panFrom.current;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragged.current = true;
    from.x = e.clientX;
    from.y = e.clientY;
    // 平移只挪位置、不改尺寸，不用重排，直接落
    setView((v) => clampView({ ...v, x: v.x + dx, y: v.y + dy }, size, frame));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    fingers.current.delete(e.pointerId);
    if (fingers.current.size < 2) pinchFrom.current = null;
    if (fingers.current.size === 0) panFrom.current = null;
  };

  /**
   * 台阶一的验收：内联注入是同步的，但布局要等一拍 —— 一拍不够就多量几拍。
   *
   * 为什么不能「量一次 0 宽就降级 img」：mermaid 的内联 SVG 里带着 foreignObject
   * （HTML 标签），塞进 <img>（blob: 也一样）必定画不出来 —— 降过去等于把图判死。
   * 所以对内联图绝不走 img 这一级：先重试，再把 svg 自带的 max-width 掰开重试，
   * 都立不住才认输、说人话。
   */
  useEffect(() => {
    if (!pic?.inlineSvg || mode !== "auto") return;
    let alive = true;
    const check = () => {
      if (!alive) return;
      const el = svgBox.current?.querySelector("svg");
      const w = el ? el.getBoundingClientRect().width : 0;
      const n = tries.current;
      trace("内联验收", {
        第几拍: n + 1,
        找到svg: !!el,
        宽度: Math.round(w),
        viewBox: el?.getAttribute("viewBox") ?? "",
        自带maxWidth: el?.style?.maxWidth || "(无)",
        已掰开: forcing,
      });
      if (el && w >= 4) {
        trace("内联立住了，停在这一级", { 宽度: Math.round(w) });
        // viewBox 才是这张图自己的坐标系，用它的宽高当固有尺寸
        const vb = el.viewBox?.baseVal;
        adopt(
          {
            w: vb?.width || w,
            h: vb?.height || el.getBoundingClientRect().height,
          },
          true,
        );
        return;
      }
      if (el && !forcing && n >= 3) {
        trace("内联塌成 0 宽，掰开 max-width 再量", { 宽度: Math.round(w) });
        setForcing(true);
        tries.current = 0;
        setTimeout(check, 60);
        return;
      }
      if (n >= 8) {
        console.error(
          "[看图] 内联没立起来，也没有能替代的路（mermaid 图进不了 <img>）",
          {
            找到svg: !!el,
            宽度: Math.round(w),
            源码长度: pic.inlineSvg?.length ?? 0,
          },
        );
        setMode("miss");
        return;
      }
      tries.current = n + 1;
      setTimeout(check, 80);
    };
    setTimeout(check, 60);
    return () => {
      alive = false;
    };
  }, [pic, mode, forcing]);

  if (!pic) return null;

  // 下载时给个像样的文件名：地址里最后那一段就是云盘里的 key。
  // 模型手写的地址可能是过不去的编码，解不开就退回原样的那一段。
  const raw = pic.src.split("/").pop() || "";
  let name = raw || "图片";
  try {
    name = decodeURIComponent(raw) || name;
  } catch {
    // 解不开就用手上这段原样的
  }

  const imgFallback = (ev: SyntheticEvent<HTMLImageElement>) => {
    const isSvgFile = /\.svg($|\?)/i.test(pic.src);
    trace("<img> 台阶失败", {
      地址: brief(pic.src),
      是svg文件: isSvgFile,
      已有内联源码: !!pic.inlineSvg,
      量到的自然宽: (ev.target as HTMLImageElement).naturalWidth,
    });
    // .svg 文件在 <img> 里装不下（foreignObject 一类）：把源文件取回来内联再试
    if (isSvgFile && !pic.inlineSvg) {
      fetch(pic.src)
        .then((r) => {
          trace(".svg 取源回来", { 状态码: r.status, ok: r.ok });
          return r.ok
            ? r.text()
            : Promise.reject(new Error(`HTTP ${r.status}`));
        })
        .then((t) => {
          if (!t.includes("<svg")) throw new Error("取回来的内容里没有 <svg>");
          trace(".svg 转内联成功，回到内联台阶", { 源码长度: t.length });
          const blob = URL.createObjectURL(
            new Blob([t], { type: "image/svg+xml" }),
          );
          setPic((p) => {
            dropPic(p);
            return p ? { ...p, inlineSvg: t, src: blob } : p;
          });
          setForcing(false);
          tries.current = 0;
          setMode("auto");
        })
        .catch((err) => {
          console.error("[看图] .svg 取源/转内联失败", {
            地址: brief(pic.src),
            原因: err instanceof Error ? err.message : String(err),
          });
          setMode("miss");
        });
      return;
    }
    console.error("[看图] 走到兜底：这张图在当前窗口没有可走的路", {
      地址: brief(pic.src),
      是svg文件: isSvgFile,
    });
    setMode("miss");
  };

  return (
    <div className="lightbox" onClick={() => setPic(dropPic)}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">{pic.alt || name}</span>
        {mode === "miss" || !nat ? null : (
          <>
            <button
              className="lightbox-btn"
              onClick={() => {
                const f = frameNow();
                if (f && nat) setView((v) => zoomTo(v, f, nat, 1 / ZOOM_STEP));
              }}
              title="缩小"
            >
              <Icon name="minus" size={16} />
            </button>
            <button
              className="lightbox-pct"
              onClick={toggleSize}
              title="点一下在「适配屏幕」和「原尺寸 100%」之间来回"
            >
              {Math.round(view.s * 100)}%
            </button>
            <button
              className="lightbox-btn"
              onClick={() => {
                const f = frameNow();
                if (f && nat) setView((v) => zoomTo(v, f, nat, ZOOM_STEP));
              }}
              title="放大"
            >
              <Icon name="plus" size={16} />
            </button>
          </>
        )}
        <a
          className="lightbox-btn"
          href={pic.src}
          download={name}
          title="下载原图"
        >
          <Icon name="download" size={15} />
        </a>
        <a
          className="lightbox-btn"
          href={pic.src}
          target="_blank"
          rel="noopener noreferrer"
          title="新窗口打开"
        >
          <Icon name="maximize" size={15} />
        </a>
        <button
          className="lightbox-btn"
          onClick={() => setPic(dropPic)}
          title="关掉（Esc）"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      {mode === "miss" ? (
        // 三级台阶全走完了：明说没打开成，把源文件的门留着 —— 不留一片空白让人以为是卡了
        <p className="lightbox-miss">
          这张图没能在这个窗口里打开 —— 内容太大或格式太挑。
          {pic.src ? (
            <>
              {" "}
              源文件还在，
              <a href={pic.src} target="_blank" rel="noopener noreferrer">
                在新窗口打开
              </a>
              试试；不行就用上面的下载按钮存下来看。
            </>
          ) : null}
        </p>
      ) : (
        // 图装在一层可以缩放/平移的「画布」里，遮罩留着 —— 点画布外的空白仍然关图
        <div
          ref={viewport}
          className="lightbox-view"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={(e) => {
            // 拖过的那一下不是「点空白」，别顺手把图关了
            if (dragged.current) e.stopPropagation();
          }}
        >
          <div
            className="lightbox-stage"
            onClick={(e) => e.stopPropagation()}
            // 双击：放大看细节；已经比原尺寸大了就退回适配视角
            onDoubleClick={() => {
              const f = frameNow();
              if (!f || !nat) return;
              setView((v) =>
                v.s > 1.05
                  ? fitView(nat, f, !!pic.inlineSvg)
                  : zoomTo(v, f, nat, 2.5),
              );
            }}
            // 位置只有平移、没有缩放：图多大是宽度说了算的
            style={{ transform: `translate(${view.x}px, ${view.y}px)` }}
          >
            {pic.inlineSvg && mode === "auto" ? (
              // mermaid 的图不走 <img>：原地注入，和正文里那张是同一份 DOM
              <div
                ref={svgBox}
                className={`lightbox-img lightbox-svg${
                  nat ? " lightbox-fit" : ""
                }${forcing ? " lightbox-svg-force" : ""}`}
                style={
                  nat ? { width: `${Math.round(nat.w * view.s)}px` } : undefined
                }
                dangerouslySetInnerHTML={{ __html: pic.inlineSvg }}
              />
            ) : (
              <img
                className={`lightbox-img${nat ? " lightbox-fit" : ""}`}
                style={
                  nat ? { width: `${Math.round(nat.w * view.s)}px` } : undefined
                }
                src={pic.src}
                alt={pic.alt || name}
                draggable={false}
                onLoad={(e) => {
                  const t = e.currentTarget;
                  adopt({ w: t.naturalWidth, h: t.naturalHeight }, false);
                }}
                onError={imgFallback}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
