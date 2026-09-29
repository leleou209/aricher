// 点开看大图。
//
// 为什么走 window 上的一个自定义事件，而不是把回调一层层往下传：
// 图出现在三个地方（正文里的 markdown、工具卡里的 Drawn、记忆面板的缩略图），
// 而正文那个 Markdown 是 memo 过的 —— 每来一个 chunk 都可能重渲，
// 传进去的回调一旦换身份，memo 就白做了（整场历史都要重新解析一遍）。
// 事件是模块级的：谁看见图谁喊一声，不需要谁记得往下传，也不牵动渲染。

import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import "./Lightbox.css";

const ZOOM_EVENT = "ericher:zoom";

/** 任何地方看见一张能看的图，都调它放大 */
export function zoomIn(src: string, alt: string) {
  if (!src) return;
  window.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: { src, alt } }));
}

/**
 * 铺满一屏的看图层。顶部工具条上是「下载原图 / 新窗口打开 / 关掉」，
 * Esc 或点空白处也能关 —— 看图的时候手最不想离开键盘。
 */
export function Lightbox() {
  const [pic, setPic] = useState<{ src: string; alt: string } | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    const onZoom = (e: Event) => {
      setPic((e as CustomEvent<{ src: string; alt: string }>).detail);
      setBroken(false);
    };
    window.addEventListener(ZOOM_EVENT, onZoom);
    return () => window.removeEventListener(ZOOM_EVENT, onZoom);
  }, []);

  useEffect(() => {
    if (!pic) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPic(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pic]);

  if (!pic) return null;

  // 下载时给个像样的文件名：地址里最后那一段就是云盘里的 key。
  // 模型手写的地址可能是过不去的编码，解不开就退回原样的那一段 ——
  // 这里不值得为它把整个看图层崩掉。
  const raw = pic.src.split("/").pop() || "";
  let name = raw || "图片";
  try {
    name = decodeURIComponent(raw) || name;
  } catch {
    // 解不开就用手上这段原样的
  }

  return (
    <div className="lightbox" onClick={() => setPic(null)}>
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
          onClick={() => setPic(null)}
          title="关掉（Esc）"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      {broken ? (
        // 没取到的时候说清是「没取到」，而不是留一片空白让人以为是卡了。
        // 地址也摆出来：是地址写错了、还是云盘里已经没有它，一眼能看出来。
        <p className="lightbox-miss">
          这张图没取回来 —— 地址是 {pic.src}。云盘里可能已经没有它了。
        </p>
      ) : (
        <img
          className="lightbox-img"
          src={pic.src}
          alt={pic.alt || name}
          onClick={(e) => e.stopPropagation()}
          onError={() => setBroken(true)}
        />
      )}
    </div>
  );
}
