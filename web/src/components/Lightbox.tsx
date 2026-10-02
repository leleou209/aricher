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
 * 换图 / 关图时把 blob 地址放掉 —— mermaid 大图的 blob 是真占内存的字节引用，
 * 不像 data: 只是一串字符。data: 等其它地址原样放行（revoke 对它们无意义也不报错，
 * 但省一次判断之外的方法调用）。
 */
function dropPic(p: { src: string; alt: string } | null) {
  if (p && p.src.startsWith("blob:")) URL.revokeObjectURL(p.src);
  return null;
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
      const next = (e as CustomEvent<{ src: string; alt: string }>).detail;
      // 连开两张时先放掉前一张的 blob，再换上去
      setPic((prev) => {
        dropPic(prev);
        return next;
      });
      setBroken(false);
    };
    window.addEventListener(ZOOM_EVENT, onZoom);
    return () => window.removeEventListener(ZOOM_EVENT, onZoom);
  }, []);

  useEffect(() => {
    if (!pic) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPic(dropPic);
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
      {broken ? (
        // 没取到的时候说清是「没取到」，而不是留一片空白让人以为是卡了。
        // 地址只对「云盘路径」这种短地址有排障价值；data:/blob: 是把整张图
        // 塞进地址里的大块头 —— 原样摆出来就是一屏乱码，只说原因
        <p className="lightbox-miss">
          {pic.src.startsWith("data:") || pic.src.startsWith("blob:")
            ? "这张图没能渲染出来 —— 图的内容太大，浏览器装不下这段地址。"
            : `这张图没取回来 —— 地址是 ${pic.src.slice(0, 300)}${pic.src.length > 300 ? "…" : ""}。云盘里可能已经没有它了。`}
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
