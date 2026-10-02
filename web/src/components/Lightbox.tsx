// 点开看大图。
//
// 为什么走 window 上的一个自定义事件，而不是把回调一层层往下传：
// 图出现在三个地方（正文里的 markdown、工具卡里的 Drawn、记忆面板的缩略图），
// 而正文那个 Markdown 是 memo 过的 —— 每来一个 chunk 都可能重渲，
// 传进去的回调一旦换身份，memo 就白做了（整场历史都要重新解析一遍）。
// 事件是模块级的：谁看见图谁喊一声，不需要谁记得往下传，也不牵动渲染。

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";
import "./Lightbox.css";

const ZOOM_EVENT = "ericher:zoom";

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
 * 铺满一屏的看图层。顶部工具条上是「下载原图 / 新窗口打开 / 关掉」，
 * Esc 或点空白处也能关 —— 看图的时候手最不想离开键盘。
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
      // 连开两张时先放掉前一张的 blob，再换上去
      setPic((prev) => {
        dropPic(prev);
        return { ...next, src };
      });
      setMode("auto");
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

  // 台阶一的验收：内联注入是同步的，稍等一拍再量 —— svg 没立起来就降级
  useEffect(() => {
    if (!pic?.inlineSvg || mode !== "auto") return;
    const t = setTimeout(() => {
      const el = svgBox.current?.querySelector("svg");
      const w = el ? el.getBoundingClientRect().width : 0;
      if (!el || w < 4) setMode("img");
    }, 80);
    return () => clearTimeout(t);
  }, [pic, mode]);

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

  const imgFallback = () => {
    // .svg 文件在 <img> 里装不下（foreignObject 一类）：把源文件取回来内联再试
    if (/\.svg($|\?)/i.test(pic.src) && !pic.inlineSvg) {
      fetch(pic.src)
        .then((r) =>
          r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)),
        )
        .then((t) => {
          if (!t.includes("<svg")) throw new Error("不是 SVG");
          const blob = URL.createObjectURL(
            new Blob([t], { type: "image/svg+xml" }),
          );
          setPic((p) => {
            dropPic(p);
            return p ? { ...p, inlineSvg: t, src: blob } : p;
          });
          setMode("auto");
        })
        .catch(() => setMode("miss"));
      return;
    }
    setMode("miss");
  };

  return (
    <div className="lightbox" onClick={() => setPic(dropPic)}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">{pic.alt || name}</span>
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
      ) : pic.inlineSvg && mode === "auto" ? (
        // mermaid 的图不走 <img>：原地注入，和正文里那张是同一份 DOM
        <div
          ref={svgBox}
          className="lightbox-img lightbox-svg"
          onClick={(e) => e.stopPropagation()}
          dangerouslySetInnerHTML={{ __html: pic.inlineSvg }}
        />
      ) : (
        <img
          className="lightbox-img"
          src={pic.src}
          alt={pic.alt || name}
          onClick={(e) => e.stopPropagation()}
          onError={imgFallback}
        />
      )}
    </div>
  );
}
