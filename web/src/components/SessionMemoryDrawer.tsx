// 聊天界面左边的回想抽屉。
//
// 和笔记本抽屉存在同一个理由：跟他说「上次我们说的那个」的时候，
// 得能在同一屏里翻一眼他那次到底记了什么，而不是切走整个页面再切回来。
//
// 这里是只读的：条目是他自己回头看留下的，随手改别人的回忆不合适。
// 想按场细筛、想叫他这会儿再看一眼，去回想页（那边地方大）。

import { Icon } from "./Icons";
import { MemoCard, MemoFilters, useSessionMemories } from "./SessionMemoryPage";
import "./NoteMemo.css";

export function SessionMemoryDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // 合着的时候不拉数据：抽屉常年挂在 DOM 上（动画要它）
  const m = useSessionMemories(open);

  return (
    <aside
      className={`drawer-left memo-drawer ${open ? "open" : ""}`}
      aria-hidden={!open}
    >
      <div className="nm-drawer-head">
        <h1 className="nm-drawer-title">回想</h1>
        <button className="icon-btn" title="收起" onClick={onClose}>
          <Icon name="x" size={17} />
        </button>
      </div>

      <p className="nm-hint">
        <Icon name="clock" size={13} />
        你停下半小时后，他会自己把刚才那一段回头看一遍 —— 这里是他记下的。
      </p>

      <MemoFilters
        q={m.q}
        onQ={m.setQ}
        band={m.band}
        onBand={m.setBand}
        sentiment={m.sentiment}
        onSentiment={m.setSentiment}
      />

      <div className="nm-feed">
        {!m.busy && !m.list.length && (
          <p className="nm-empty">
            他还没回头看过。你停下半小时之后，他会自己回顾刚才那一段。
          </p>
        )}
        {m.list.map((e) => (
          <MemoCard
            key={e.id}
            entry={e}
            sessionTitle={m.titles.get(e.sessionId) || ""}
          />
        ))}
      </div>

      {m.err && <p className="nm-err">{m.err}</p>}
    </aside>
  );
}
