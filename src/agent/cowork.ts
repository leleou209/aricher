// ericher 主体：AIChatAgent + 原生工具调用。
//
// 类名 CoworkAgent 必须保持不变 —— DO 存储按类标识派生，改名等于换存储桶，
// 既有 memories / state 全部读不到。

import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions,
} from "@cloudflare/ai-chat";
import {
  getCurrentAgent,
  type Connection,
  type ConnectionContext,
} from "agents";
import {
  convertToModelMessages,
  generateText,
  pruneMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type StreamTextOnFinishCallback,
  type ToolSet,
  type UIMessage,
} from "ai";
import {
  adminPassword,
  authToken,
  gatePassword,
  OWNER_AGENT,
  verifyTokenInfo,
  type Role,
} from "../auth";
import {
  maintenanceModel,
  resolveModel,
  titleModel,
  TITLE_PROVIDER_OPTIONS,
  type ResolvedModel,
} from "../providers";
import {
  addComment,
  commentCounts,
  ensureFeedbackSchema,
  listComments,
  listFlags,
  listVotes,
  setVote,
  toggleFlag,
  voteTotals,
  type CommentRow,
  type VoteValue,
} from "./feedback";
import { buildTools, type ToolCtx } from "../tools";
import {
  confirmMemory,
  conflictBlock,
  countMemories,
  deleteMemory,
  deleteVector,
  ensureMemorySchema,
  findConflicts,
  getMemory,
  insertMemory,
  listConflicted,
  listDueForReview,
  listMemories,
  listMemoriesByPerson,
  listPersons,
  listPublicMemories,
  listSessionMemories,
  listSuperseded,
  listTagAccess,
  memoryHitLines,
  restoreMemory,
  searchMemories,
  sessionMemoryCounts,
  setConflicts,
  setSensitivity,
  setTagAccess,
  setVisibility,
  setVolatility,
  settleConflicts,
  supersedeMemory,
  tagStats,
  upsertVector,
  type SessionMemoryQuery,
  type TagGate,
  type TagStat,
  type Volatility,
} from "./memory";
import {
  appendSessionMessage,
  ensureSessionSchema,
  getSession,
  getSessionDigest,
  insertSession,
  listPublicSessions,
  listSessions,
  loadSessionMessages,
  markSessionRead,
  markSessionUnread,
  newSessionId,
  removeSession,
  renameSession,
  resetLegacyRecapCursors,
  saveSessionMessages,
  searchMessages,
  setSessionArchived,
  setSessionDigest,
  setSessionVisibility,
  touchSession,
  type RecallHit,
  type SessionMeta,
  type SessionVisibility,
} from "./sessionStore";
import {
  REMINDER_CAP,
  cancelReminderRow,
  countPendingReminders,
  ensureReminderSchema,
  getReminder,
  insertReminder,
  listPendingReminders,
  markReminderFired,
  newReminderId,
  setReminderScheduleId,
  type Reminder,
} from "./reminderStore";
import {
  SAY_DEBOUNCE_MS,
  beijingDayStart,
  countSaysSince,
  enqueueSay,
  ensureSpeakSchema,
  inQuietHours,
  listPendingSays,
  markSaysDelivered,
  mergeSays,
  pruneSays,
  quietEndsAt,
} from "./speakGate";
import {
  createGuestType as createGuestTypeRow,
  ensureGuestTypesSchema,
  findGuestTypeByPassword,
  getGuestType,
  listGuestTypes as listGuestTypeRows,
  removeGuestType as removeGuestTypeRow,
  toGuestTypeInfo,
  toGuestTypePublic,
  updateGuestType as updateGuestTypeRow,
  disabledGuestTypeInfo,
  type GuestTypeInfo,
  type GuestTypeInput,
  type GuestTypePatch,
  type GuestTypePublic,
  type GuestTypeRow,
} from "./guestTypes";
import {
  COMMON_TYPE_ID,
  createUserCard,
  getUserCard,
  listUserCards,
  toUserCardPublic,
  verifyCardLogin as verifyCardLoginRow,
  type UserCardPublic,
} from "./userCards";
import {
  createPublicPost,
  listPublicPosts,
  removePublicPost,
  type PublicPost,
} from "./publicPosts";
import {
  ensureVisitorSchema,
  isNewJoin,
  listVisitorEvents,
  listVisitorRooms,
  logVisitorEventBatch,
  logVisitorEventRow,
  buildVisitorEvent,
  registerVisitorRoom as registerVisitorRoomRow,
  type VisitorEvent,
  type VisitorRoom,
} from "./visitor";
import {
  activateModelEntry,
  createModelEntry,
  createModelProvider,
  ensureModelCatalogSchema,
  getActiveCatalog,
  getCatalogById,
  listModelEntries,
  listModelProviders,
  removeModelEntry,
  removeModelProvider,
  updateModelEntry,
  updateModelProvider,
  type ActiveCatalog,
  type ModelEntry,
  type ModelEntryPatch,
  type ModelProvider,
  type ModelProviderInput,
  type ModelProviderPatch,
} from "./modelConfigs";
import {
  createTtsConfig,
  ensureTtsConfigsSchema,
  listTtsConfigs,
  removeTtsConfig,
  updateTtsConfig,
  type TtsConfig,
  type TtsConfigInput,
  type TtsConfigPatch,
} from "./ttsConfigs";
import {
  deleteNote as deleteNoteRow,
  ensureNoteSchema,
  getNote,
  listNotes as listNoteRows,
  listRevisions,
  noteFocusBlock,
  restoreRevision,
  saveNote as saveNoteRow,
  type Note,
  type NoteInput,
  type NoteMeta,
  type NoteRevision,
} from "./noteStore";
import {
  CACHE_PROVIDER_OPTIONS,
  DIGEST_MAX,
  digestBlock,
  digestPrompt,
  markCacheBreakpoint,
  planContext,
} from "./context";
import {
  EXP_CAP,
  EXP_EVERY,
  EXP_WINDOW,
  experiencePrompt,
  isDuplicate,
  parseExperience,
} from "./experience";
import {
  buildBasePrompt,
  selfDemandBlock,
  stripToolGuide,
  toolGuide,
} from "./prompt";
import { titleSystem, tidyTitle, titlePrompt } from "./title";
import {
  installMigration,
  runMigration,
  type MigrationReport,
} from "./migration";
import {
  meterOf,
  sqlText,
  type Meter,
  type MeterCell,
  type WriteReport,
} from "./meter";
import { usage, type ResourceReport } from "./usage";
import { coalesceStream } from "./coalesce";
import { Thinker } from "./think";
import {
  installRuntime,
  runContinueTask,
  runHeartbeat,
  runNightlyMaintenance,
} from "./runtime";
import {
  freshSegment,
  resyncRecaps,
  runSessionRecap,
  scheduleRecap,
} from "./recap";
import {
  INITIAL_STATE,
  PATCHABLE_KEYS,
  migrateServiceCopy,
  seedMemories,
  seedPatch,
  type ChatState,
  type MemEntry,
  type SeedOp,
  type Sensitivity,
  type SqlTag,
  SENSITIVITIES,
  type Task,
} from "./state";

/** 闲置超过这个时长就认为是一段新关系，清掉旧对话 */
const IDLE_RESET_MS = 30 * 24 * 60 * 60 * 1000;

/** 导出时跳过的内部簿记表：迁移游标、配额计量——可重建的运行时状态，不是要备份的家当 */
const EXPORT_SKIP = new Set(["migration_flags", "write_meter", "task_cursor"]);
/** 导出时剥离的敏感列：备份文件里不该出现任何可用于登录的东西（摘要也不给） */
const EXPORT_SENSITIVE: Record<string, string[]> = {
  guest_types: ["password"],
  // 身份卡的口令散列：虽然只是散列，但离线撞库不需要联网 —— 备份文件里一样不能有
  user_cards: ["password_hash"],
};

/**
 * lastActive 落库的最小间隔。
 *
 * 每连一次、每切一次会话都写一整份 state blob（一行）再广播一遍，而这个字段
 * 只给自己做「闲置多久」的判定用 —— 判定尺子是 30 天，五分钟的粒度绰绰有余。
 * 额度紧张的当下，这类「什么也没改、只是报个时辰」的写该省掉。
 */
const LAST_ACTIVE_FLUSH_MS = 5 * 60 * 1000;

const MAX_STEPS = 8;

/** 「她正在想什么」那一次翻写的上限：翻过这一秒，外面早就等到正文了（见 think.ts） */
const THINK_TIMEOUT = 12_000;

/**
 * 来客房缓存「生效模型目录组」的时长（见 fetchActiveCatalog）。
 * 跨间调用一趟不便宜，目录是改一次用很久的东西 —— 半分钟的生效延迟
 * 换每句话少一跳往返，划算。
 */
const ACTIVE_CONFIG_CACHE_MS = 30_000;

function messageText(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
}

export class CoworkAgent extends AIChatAgent<Env, ChatState> {
  initialState: ChatState = INITIAL_STATE;

  /** 只保留最近 200 条消息在 SQLite 里，避免无限增长 */
  maxPersistedMessages = 200;

  /** 用户中途补充说明时，以最后一条为准，避免同时跑两轮 */
  messageConcurrency = "latest" as const;

  /**
   * 关闭 WebSocket 休眠：连接断了，屋子不散。
   *
   * 默认 hibernate:true 的行为是「最后一个连接一断，实例随时可以原地冻结」——
   * 而一轮多段工具链里满是秒级的空等（每步模型调用之间），运行时专挑这些空档
   * 把实例休眠掉，进行中的流阅读器当场被杀：工具卡悬着「结果没回来」、正文截在
   * 半截，人回来看到的不是「她还在跑」而是一具尸体。
   *
   * 换成内存连接管理器后，连接断了在途工作也照常跑完、落库完，才轮得到回收。
   * 离开页面、双开另一场聊天，正在跑的这一轮都不受影响 —— 后台任务靠这行活命。
   * 代价是连接挂着的期间实例不进休眠（内存常驻）：单人聊天，无所谓。
   */
  static options = { hibernate: false };

  /**
   * 长思考要扛得住「跑到一半被驱逐 / 断线」。
   *
   * 打开它，这一轮就跑在一个 durable fiber 里：fiber 的登记先落 SQLite，全程握着
   * keepAlive（不会被空闲驱逐），万一还是被重启掐断，下一次唤醒时基类会把已经流出去
   * 的那半截从流缓冲里捞出来落库，再自己续一轮（见基类 _handleInternalFiberRecovery）。
   * 不打开的话，这一轮只活在内存里 —— 进程一没，她说过的话和她正在做的事一起消失，
   * 前端那边看到的就是「说到一半没了」，而且永远等不到下半句。
   *
   * 代价是多一张 cf_agents_runs 表的读写。相比「长回答说没就没」，这个代价划得来。
   */
  chatRecovery = true;

  /**
   * Agent.sql 是依赖 `this.ctx` 的原型方法。写成 `agent.sql\`...\`` 是方法调用、this 正确，
   * 但把它当值传递（如 `f(this.sql)`）会丢 this，运行时报
   * "Cannot read properties of undefined (reading 'ctx')"。所有传递场景统一用这个绑定版本。
   */
  private dbTag?: SqlTag;
  get db(): SqlTag {
    return (this.dbTag ??= this.sql.bind(this) as unknown as SqlTag);
  }

  /** `env` 在基类里是 protected，迁移等外部模块通过这个公开别名读取。 */
  get appEnv(): Env {
    return this.env;
  }

  /**
   * 不带计量的原生 sql。
   * 计量器自己落账要用它 —— 用带计量的那个，就成了「为了记账而记账」，
   * 每写一行账又多出一行账，越记越多。
   */
  private rawSqlTag?: SqlTag;
  private get rawSql(): SqlTag {
    return (this.rawSqlTag ??= super.sql.bind(this) as unknown as SqlTag);
  }

  /**
   * 今天写了多少行、写到哪儿去了。
   *
   * 每次都重新 attach：闭包只引用 this 和原型上的方法，所以哪怕基类构造时
   * 就发了 SQL（那会儿子类字段还没初始化），挂上去的回调照样是好的。
   */
  private get meter(): Meter {
    const m = meterOf(this);
    if (!m.attached) {
      m.attached = true;
      m.attach(
        (day, cells) => this.writeMeterSink(day, cells),
        (day) => this.writeMeterLoader(day),
      );
    }
    return m;
  }

  /**
   * 「她正在想什么」（见 think.ts）。
   *
   * 一间屋子一个：轮次号要一直往上走，客户端才分得清飘过来的哪句属于这一轮。
   */
  private thinker = new Thinker({
    ask: (system, user) => this.thinkAsk(system, user),
    emit: (turn, line) => this.emitThought(turn, line),
  });

  /**
   * 计量每一次 SQL —— 包括 SDK 自己发的那些（消息落库、状态 blob、定时任务表）。
   * 只数我自己写的没意义：免费层每天 10 万行是整间屋子共用的，
   * 而超限之后连「读」都会一起失败，整个 DO 就瘫了。
   */
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const rows = super.sql<T>(strings, ...values);
    this.meter.note(sqlText(strings), rows.length);
    return rows;
  }

  /** 落账：一天一行、一个来源一行，攒够一批写一次（见 meter.ts 的 FLUSH_EVERY）。 */
  private writeMeterSink(day: string, cells: MeterCell[]): void {
    this.ensureMeterSchema();
    for (const c of cells) {
      this
        .rawSql`INSERT INTO write_meter (day, key, n) VALUES (${day}, ${c.key}, ${c.n})
        ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n`;
    }
  }

  /** 读账：驱逐重启后把今天已经写掉的数接回来，面板上的数字才不会倒退。 */
  private writeMeterLoader(day: string): MeterCell[] {
    this.ensureMeterSchema();
    const rows = this.rawSql<{
      key: string;
      n: number;
    }>`SELECT key, n FROM write_meter WHERE day = ${day}`;
    // 写和读怎么分、哪些不算（结构变更），都由 meter.ts 一处说了算，这里只管搬数据
    return rows.map((r) => ({ key: r.key, n: r.n }));
  }

  private meterReady = false;
  private ensureMeterSchema(): void {
    if (this.meterReady) return;
    // 先置位再建表：建表本身也是一条 SQL，不置位会绕回来
    this.meterReady = true;
    try {
      this.rawSql`CREATE TABLE IF NOT EXISTS write_meter (
        day TEXT NOT NULL,
        key TEXT NOT NULL,
        n   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, key)
      )`;
    } catch {
      // 建不出来就退化成「只在内存里数」，不影响干活
      this.meterReady = false;
    }
  }

  /** 今日写额度（面板用）。纯读内存 + 一次落账，不额外扫表。 */
  writeReport(): WriteReport {
    return this.meter.report();
  }

  /**
   * AI neurons / Vectorize 的自计量（面板用）。
   * 纯内存账（见 usage.ts），顺带把 state 里的旧账接回来 —— 只接一次。
   */
  resourceReport(): ResourceReport {
    usage.hydrate(this.state.usage);
    return usage.report();
  }

  /**
   * 把资源账写回 state：只在主人那间、且数字真的动了的时候写。
   * state 落盘一次就是一行写入 —— 这本账本身不该反过来吃额度。
   */
  private flushUsage(): void {
    if (!this.isOwnerRoom) return;
    usage.hydrate(this.state.usage);
    if (!usage.dirty()) return;
    this.patchState({ usage: usage.snapshot() });
    usage.markFlushed();
  }

  /**
   * 我是不是主人那一间屋子。
   *
   * 一个 DO 只有一份对话，所以来客各有自己的实例（名字由登录 token 派生，见 auth.ts）。
   * 主人那间才有人格内核、记忆播种和「外面世界」以外的工具；
   * 来客那间只有人格提示词和几个对外工具 —— 他们不该动主人的记忆、邮件和文件。
   * （runtime.ts 也读它：来客那间不排夜间整理，省下一次白烧的模型调用。）
   */
  get isOwnerRoom(): boolean {
    return this.name === OWNER_AGENT;
  }

  /**
   * 守则和自我要求是共用的 —— 换了谁来聊天，我还是同一套做法，不该换一套说法。
   *
   * 管理员那间就存在自己 state 里（设置页能改守则，自我要求由我用 self 工具写）；
   * 来客那间两样都不存，每次连上来时去管理员那间取一份，取不到就用出厂默认。
   * 不共用的话，管理员一改守则、我自己一改要求，来客那边还是老样子 —— 等于养出两个 ericher。
   * 取的只有这两样：管理员的记忆和内核从来不跨房间。
   */
  private personaCache = "";
  private demandCache = "";
  private async refreshPersona(): Promise<void> {
    if (this.isOwnerRoom) return;
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      const cfg = await owner.getConfig();
      this.personaCache =
        typeof cfg?.basePrompt === "string" ? cfg.basePrompt : "";
      this.demandCache =
        typeof cfg?.selfDemand === "string" ? cfg.selfDemand : "";
    } catch {
      // 主人那间没醒 / 调用出错都留空：buildBasePrompt 会回落到出厂人设，聊天照常
    }
  }

  /** 这一轮该用哪份人设。 */
  private personaForPrompt(): string {
    return this.isOwnerRoom ? this.state.basePrompt : this.personaCache;
  }

  /** 这一轮该用哪份自我要求。同上：她是同一个人，要求也一样。 */
  private demandForPrompt(): string {
    return this.isOwnerRoom ? this.state.selfDemand || "" : this.demandCache;
  }

  /**
   * 来客那间记下的一条，回主人这边留一份（两边都留，理由见 tools/memory.ts）。
   *
   * 前缀写「来客说：」：即使有称呼，这也不是管理员认识的人的名字，
   * 而是这位客人自己的归属标记 —— 人名一律带「来客·」前缀，永远撞不到真名上。
   * person 只管展示；授权归属跟 ownerKey（room:<来客房间名>）走 ——
   * 房间名是 Worker 按签名票派生的，自报的称呼做不了钥匙（见 guestReadableMemories）。
   */
  async receiveGuestMemory(input: {
    content: string;
    shelf?: string;
    tags?: string[];
    volatility?: "stable" | "volatile";
    /** 来客自报的称呼，只作展示（person 字段） */
    person?: string;
    /** 经核实的归属键：调用房自己的名字，由调用方服务端注入，不经过客人的手 */
    ownerKey?: string;
  }): Promise<void> {
    const content = (input.content || "").trim();
    if (!content) return;
    ensureMemorySchema(this.db);
    const who = (input.person || "").trim().slice(0, 20)
      ? `来客·${input.person!.trim().slice(0, 20)}`
      : "";
    const entry = insertMemory(this.db, {
      type: "fact",
      content: "来客说：" + content,
      shelf: input.shelf,
      tags: [...(input.tags || []), "来客"],
      volatility: input.volatility,
      person: who,
      ownerKey: input.ownerKey,
    });
    this.enqueueVector({
      id: entry.id,
      content: entry.content,
      type: entry.type,
      shelf: entry.shelf,
      tags: entry.tags,
    });
  }

  /**
   * 来客那间来问：和这句话有关的、他读得到的记忆。
   *
   * 「读得到」= 两档的并集：管理员公开过的（含 tag 门放行的），加上他自己名下的
   * （owner_key = room:<他的房间名>）。private 的主体是管理员的私事，一个字都不出这间屋子。
   * 过滤在 searchMemories 的 SQL 里完成 —— 数据层关上的门，提示词开不了。
   *
   * 归属键由调用方那间用自己的 this.name 注入（Worker 按签名票派生），
   * 不从 state.guestName 取 —— 那是客人自报的称呼，报谁都行，做不了授权凭据。
   * 持卡客人回的是卡绑定的那间屋，换个设备键也不变；无卡身份的键跟着票走，
   * 重新登录就是新的屋子 —— 没有可核实的持久身份，就不该有跨登录的私档可翻。
   */
  async guestReadableMemories(
    query: string,
    ownerKey: string,
    limit = 5,
  ): Promise<string[]> {
    const q = (query || "").trim();
    if (!q) return [];
    ensureMemorySchema(this.db);
    const hits = await searchMemories(this.db, this.env, q, limit, {
      guestOwnerKey: ownerKey || undefined,
      onlyPublic: !ownerKey,
      cache: this.recallCache,
    }).catch(() => []);
    return memoryHitLines(hits);
  }

  /** 替来客那间问一次主人那边。没醒、出错都当成「没有可读的」，不打断这一轮。 */
  private async guestReadableOf(query: string): Promise<string[]> {
    const owner = this.env.COWORK_AGENT.get(
      this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
    );
    return (
      // 归属键是这间屋子自己的名字：Worker 按票派生出来的，客人改不了
      (await owner.guestReadableMemories(query, `room:${this.name}`, 5)) || []
    );
  }

  /**
   * 账本的骨架：管理员标了「公开」的那些条目。
   *
   * 这个方法的名字直白是故意的 —— 它是跨房间调用的入口，
   * 来客那间来取的时候，一眼要能看出取走的到底是哪一档。
   */
  publicMemoryEntries(limit = 300): MemEntry[] {
    ensureMemorySchema(this.db);
    return listPublicMemories(this.db, limit);
  }

  /**
   * 公开账本 = 管理员公开的那些 + 他这场自己登记的。
   *
   * 为什么两边都要：管理员公开的那些是「这个家里有谁、该怎么称呼」的底子，
   * 客人来了知道对面是谁才不算失礼；他自己写下的那几笔则是这一场的来意，
   * 不显示出来的话，他刚写完就看不见了，会以为没存上。
   *
   * 主人那间打开时就是自己公开的那一档 —— 账本的概念只对访客成立，
   * 管理员看的是完整的记忆面板（那边有增删改）。
   *
   * 只读：来客那间没有任何改 / 删 / 作废的入口，这是账本的规矩 ——
   * 谁都能往上添一笔，但已经写下的那笔不归别人动。
   */
  async publicLedger(limit = 300): Promise<MemEntry[]> {
    if (this.isOwnerRoom) return this.publicMemoryEntries(limit);
    ensureMemorySchema(this.db);
    // 本房间里的都是他这场带来的（面板登记的、或者他让我记下的），不过 visibility 一道手：
    // 那些默认是 private，但对他自己算不上秘密 —— 挡的从来是跨房间，不是他自己看自己。
    const mine = listMemories(this.db, undefined, limit);
    let shared: MemEntry[] = [];
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      shared = (await owner.publicMemoryEntries(limit)) || [];
    } catch {
      // 管理员那间没醒 / 出错：至少把手边这份给他看，别把整个账本变成空白
    }
    return [...shared, ...mine];
  }

  /**
   * 现查一档的对外快照。票里声称的档位每次核对都以这一趟为准：
   * common 是内置通用档（名册里没这一页），就地给全开快照；
   * 其它档查不到、或主人那间没醒，返回失效兜底（权益全关）——
   * 核实不了的一档不能当成「还在」放行，否则删一档类型等于全员放开。
   */
  private async currentGuestType(typeId: string): Promise<GuestTypeInfo> {
    if (typeId === COMMON_TYPE_ID) {
      return {
        id: COMMON_TYPE_ID,
        name: "通用来客",
        note: "",
        permSearch: true,
        permDraw: true,
        permMemory: true,
        permNotes: true,
        permFiles: true,
        permPublic: true,
      };
    }
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      return (await owner.getTypeInfo(typeId)) || disabledGuestTypeInfo(typeId);
    } catch {
      return disabledGuestTypeInfo(typeId);
    }
  }

  /**
   * 来客在账本上自己写一笔。只能添，不能改也不能删。
   *
   * 和 tools/memory.ts 里那条路是同一件事的两种入口（他让 ericher 记 / 他自己动手写），
   * 所以两处都得往管理员那边送一份 —— 只留本地的话，他写的那些管理员永远看不到。
   *
   * 写入层的权益校验在这一道：工具没到手（注册层）是第一扇门，这里是第二扇 ——
   * HTTP 直呼（POST /api/memory、进门介绍带来历）不经过工具注册，
   * 档位把「记忆登记」关掉之后这两条路也得跟着关。权益现查现判，
   * 不信连接时留下的快照：管理员刚调低的那一档，下一笔写入就该被挡住。
   * 查不到档 / 查询失败按没有权益算 —— 宁可拒了，不能把核实失败当成放行。
   */
  async addGuestEntry(input: {
    content: string;
    shelf?: string;
    tags?: string[];
    volatility?: string;
    typeId?: string;
  }): Promise<MemEntry | null> {
    const content = (input.content || "").trim();
    if (!content) return null;
    if (!this.isOwnerRoom) {
      // 类型跟着票据走：WS 连接时 onConnect 存过一份快照；但纯 HTTP 直呼
      // （POST /api/memory、进门介绍）不经过 onConnect，快照是空的 ——
      // 以前这里拿空快照当「没类型」，整段检查被跳过，权益就 fail-open 了。
      // 现在 Worker 会把票里的 type 段带过来；两处都拿不到 = 无法核实 = 拒绝。
      const typeId = input.typeId || this.state.guestTypeId || "";
      if (!typeId) return null;
      const fresh = await this.currentGuestType(typeId);
      if (!fresh.permMemory) return null;
    }
    ensureMemorySchema(this.db);
    const tags = input.tags || [];
    // person 只管展示（面板上「来客·称呼」看得顺眼）；授权归属跟房间键走，
    // 跟着称呼走的话，谁报同一个称呼就把别人的记录认领走了
    const who = (this.state.guestName || "").trim().slice(0, 20);
    const belong = who ? `来客·${who}` : "";
    const entry = insertMemory(this.db, {
      type: "fact",
      content,
      shelf: input.shelf,
      tags,
      volatility: input.volatility === "volatile" ? "volatile" : "stable",
      person: belong,
    });
    this.enqueueVector({
      id: entry.id,
      content: entry.content,
      type: entry.type,
      shelf: entry.shelf,
      tags: entry.tags,
    });
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      await owner.receiveGuestMemory({
        content,
        shelf: entry.shelf,
        tags,
        volatility: entry.volatility,
        person: who || undefined,
        // 归属键是这间屋子自己的名字，服务端注入 —— 称呼做不了授权凭据
        ownerKey: `room:${this.name}`,
      });
    } catch {
      // 管理员那边没收到不代表没记下：本地这一份已经落地了
    }
    return entry;
  }

  /**
   * 反馈表可能建在 onStart 之前（热的旧实例不重跑 onStart），所以每个用到的地方
   * 都先过一遍这里；建表语句只在本实例生命周期内跑一次。
   */
  private feedbackReady = false;
  private ensureFeedback(): void {
    if (this.feedbackReady) return;
    ensureFeedbackSchema(this.db);
    this.feedbackReady = true;
  }

  /** 同 feedback：会话表也可能建在旧实例上，用到的地方先过一遍 */
  private sessionsReady = false;
  private ensureSessions(): void {
    if (this.sessionsReady) return;
    ensureSessionSchema(this.db);
    this.sessionsReady = true;
  }

  private remindersReady = false;
  private ensureReminders(): void {
    if (this.remindersReady) return;
    ensureReminderSchema(this.db);
    this.remindersReady = true;
  }

  /** 主动开口的攒话队列。同上：一次建好，之后每轮直接用。 */
  private speakReady = false;
  private ensureSpeak(): void {
    if (this.speakReady) return;
    ensureSpeakSchema(this.db);
    this.speakReady = true;
  }

  private notesReady = false;
  private ensureNotes(): void {
    if (this.notesReady) return;
    ensureNoteSchema(this.db);
    this.notesReady = true;
  }

  async onStart(): Promise<void> {
    ensureMemorySchema(this.db);
    this.ensureFeedback();
    this.ensureSessions();
    this.ensureReminders();
    this.ensureSpeak();
    this.ensureNotes();
    installRuntime(this);
    installMigration(this);
    // DO 的 state 是持久化 blob，新增字段不会自动补齐到老实例上。
    // 这里补一次，保证 /api/config 始终能返回 basePrompt / activeSession。
    if (typeof this.state.basePrompt !== "string")
      this.patchState({ basePrompt: "" });
    // 人设和工具说明分家之前，旧版人设的尾巴上粘着一整段「我能用的工具」。
    // 光在拼提示词时剥掉是不够的：设置页的人格底稿读的是 state 原文，
    // 不把存量洗干净，用户打开那一格看到的还是一坨混着的东西，会以为根本没做分家。
    // 不含那一段时原样返回，所以这行是幂等的，也不会平白多一次写入。
    const cleanBase = stripToolGuide(this.state.basePrompt);
    if (cleanBase !== this.state.basePrompt)
      this.patchState({ basePrompt: cleanBase });
    // 服务向改版的存量迁移：首次唤醒的快照式默认稿（basePrompt / selfModel / skills）
    // 就地换成新稿 —— 只动一字不差等于旧默认的，管理员真改过的不碰（见 migrateServiceCopy）。
    const migrated = migrateServiceCopy(this.state);
    if (Object.keys(migrated).length) this.patchState(migrated);
    // 自我要求这一格是后加的，老实例里没有：补上空串，
    // 让它以「还没写过」的样子出现，而不是 undefined 一路走到面板上。
    if (typeof this.state.selfDemand !== "string")
      this.patchState({ selfDemand: "" });
    if (typeof this.state.selfDemandVer !== "number")
      this.patchState({ selfDemandVer: 0 });
    if (!Array.isArray(this.state.selfDemandLog))
      this.patchState({ selfDemandLog: [] });
    if (typeof this.state.activeSession !== "string")
      this.patchState({ activeSession: "" });
    // 来客称呼这一格也是后加的。它比别的字段更要紧：identityBlock 每轮拼提示词都会读它，
    // 老实例里没有这一格的话，来客说一句话就整轮抛错 —— 前端那边看到的是「她不回话」。
    if (typeof this.state.guestName !== "string")
      this.patchState({ guestName: "" });
    // 提问卡这一格也是后加的：老实例里没有，补成空数组 ——
    // 否则 ask 工具第一次执行就会在 undefined 上炸掉
    if (!Array.isArray(this.state.asks)) this.patchState({ asks: [] });
    // 笔记焦点这一格也是后加的。补上空串而不是留着 undefined：noteBlock 每轮拼提示词都会读它，
    // 老实例里没有这一格的话，他一开口就整轮抛错 —— 表现就是「她不回话」。
    if (typeof this.state.noteFocus !== "string")
      this.patchState({ noteFocus: "" });
    // 来客类型 id 这一格也是后加的：老实例补成空串（= 普通票、没有档），
    // onConnect 的档位比较就不用在 undefined 上打转
    if (typeof this.state.guestTypeId !== "string")
      this.patchState({ guestTypeId: "" });
    this.dropLegacyFields();
    // 上次排程中途失败（表里写了但没有 schedule id）的提醒，这里补排一次
    void this.resyncReminders().catch(() => {});
    // 回想同理，但只在主人那间：来客那几场没有「她自己回头看」这回事。
    // 重排之前先把「老会话一律视为已回想」的历史回填抹掉 —— 回想对所有场一视同仁，
    // 幂等：真回想过的（recap_at 非空）不动，清过一次的再跑也不动。
    if (this.isOwnerRoom) {
      resetLegacyRecapCursors(this.db);
      void resyncRecaps(this).catch(() => {});
    }
  }

  async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    // 纵深防御：Worker 层的 routeAgentRequest 钩子已校验过，这里用同一套密钥独立再验一次。
    // 顺手把角色写进「连接」而不是「我自己的 state」——state 是整个 DO 共用的，
    // 谁最后连上就变成谁，而连接是每个人各自一条，不会串。
    const info = await verifyTokenInfo(this.env, authToken(ctx.request));
    if (!info) {
      conn.close(1008, "未登录");
      return;
    }
    const role: Role = info.role;
    conn.setState({ role });

    // 多档来客：票里带着档位 id（v2/v3 票）。快照每次连接都现查 ——
    // 只在「档位 id 变了」才查的话，管理员调低权益后，旧房间还揣着旧快照照常用。
    // 查不到 / 停用 / 查询失败都落失效兜底（currentGuestType 内裁决）。
    // 没带档位的普通来客票本来就是全开基线；但票从有档位换成没有时，
    // 旧快照得清掉 —— 留着就成了上一张票的权益在给这一场授权。
    if (role === "user") {
      if (!info.type) {
        if (this.state.guestTypeId)
          this.patchState({ guestTypeId: "", guestType: undefined });
      } else {
        this.patchState({
          guestTypeId: info.type,
          guestType: await this.currentGuestType(info.type),
        });
      }
    }

    // 来客进门留痕，顺手到主人那间报个到（名册，见 visitor.ts）。
    // 报不上名（主间没醒）不影响接待，下一回进门再报。
    if (!this.isOwnerRoom) {
      // 进门去重：间隔内的 WS 重连是断线不是进门（见 isNewJoin）。
      // last_seen 照刷——每次连接都该刷新的是名册那个心跳，不是留痕账本。
      if (isNewJoin(this.db, this.name)) this.logVisitor("join", "role=user");
      void this.registerToOwner().catch(() => {});
    }

    // 来客那间的人设得去主人那间取（人设是共用的，理由见 personaForPrompt）
    if (!this.isOwnerRoom) await this.refreshPersona();

    const lastActive = this.state.lastActive || 0;
    if (lastActive && Date.now() - lastActive > IDLE_RESET_MS) {
      // 不再是「清掉」而是「归档」：旧的那场留在会话列表里，随时能翻回去
      await this.createSession("很久以前").catch(() => {});
      this.touchLastActive();
      this.notify("已闲置超过一个月，上一场对话已归档到会话列表。");
      return;
    }

    this.touchLastActive();

    // 会话表在第一次连上时就建好，别等到用户去点会话列表
    this.ensureActiveSession();

    // 首次唤醒：播种人格库与初始记忆。
    // 只在主人那间播 —— 来客那间是另一场对话，不该装着主人的记忆和内核
    if (
      this.isOwnerRoom &&
      !this.state.selfModel &&
      countMemories(this.db) === 0
    ) {
      this.patchState(seedPatch());
      for (const m of seedMemories()) {
        const entry = insertMemory(this.db, m);
        this.enqueueVector({
          id: entry.id,
          content: entry.content,
          type: entry.type,
          shelf: entry.shelf,
          tags: entry.tags,
        });
      }
    }
  }

  // ── 状态与上下文 ──────────────────────────────────────

  patchState(patch: Partial<ChatState>): void {
    this.setState({ ...this.state, ...patch });
  }

  /** 上一次把 lastActive 落库的时刻（内存态，判据见 LAST_ACTIVE_FLUSH_MS） */
  private lastActiveFlushed = 0;
  /** 来客聊天的滑动窗口时间戳（只对来客房间有意义，见 onChatMessage 开头的限速） */
  private guestChatTimes: number[] = [];

  /**
   * 报个时辰。
   *
   * 内存里它随时是新的（闲置判定读库里的值，差几分钟不影响三十天那把尺子），
   * 落库最多五分钟一次 —— 每连一次、每切一场都写一整份 state blob 太贵，
   * 而这份写入换回来的信息只有「他刚才在」。
   */
  private touchLastActive(): void {
    const now = Date.now();
    if (now - this.lastActiveFlushed < LAST_ACTIVE_FLUSH_MS) return;
    this.lastActiveFlushed = now;
    this.patchState({ lastActive: now });
  }

  notify(text: string): void {
    try {
      this.broadcast(JSON.stringify({ type: "notice", text, ts: Date.now() }));
    } catch {
      // 没有连接时广播会抛错，忽略即可
    }
  }

  /** 把「她正在想什么」推给这间屋子连着的人。推不出去不是事故：界面上少一句话而已 */
  private emitThought(turn: number, line: string): void {
    try {
      this.broadcast(
        JSON.stringify({ type: "thought", turn, text: line, ts: Date.now() }),
      );
    } catch {
      // 没有连接时广播会抛错，忽略即可
    }
  }

  /**
   * 翻「她正在想什么」的那一次调用。
   *
   * 和别的小活（起标题、拟提醒）不一样，这一句是有保质期的：她下一句正文都出来了，
   * 再翻出来也没地方摆。所以给它一个上限，超时就当没翻出来 —— 宁可少说一句，
   * 不能攒着一堆过期的独白一起推出去。
   */
  private async thinkAsk(system: string, user: string): Promise<string> {
    const model = this.maintModel();
    if (!model) return "";
    try {
      const { text } = await generateText({
        model,
        system,
        prompt: user,
        maxOutputTokens: 80,
        abortSignal: AbortSignal.timeout(THINK_TIMEOUT),
      });
      return text.trim();
    } catch (e) {
      // 这一句失败了没什么可学的，但一声不吭会让「这个功能一直没生效」查不出原因
      console.error("[think] 这一句没翻出来：", e);
      return "";
    }
  }

  transcript(limit = 10): string {
    return this.messages
      .slice(-limit)
      .map((m) => `${m.role}: ${messageText(m).slice(0, 300)}`)
      .join("\n");
  }

  /**
   * 把外部给的一段消息编成人读得下的稿子。回想用。
   *
   * 和 transcript 的区别就一条：那个只看「最近几条」，这个吃谁给的那一段 ——
   * 回想要读的是「上次回头之后新添的那一段」，起点由游标定，不由条数定。
   * 说话人写「用户」「我」而不是 user/assistant：这一轮是他在读自己的事，
   * 用 role 那两个词会让它读起来像日志。
   */
  sessionTranscript(msgs: UIMessage[]): string {
    return msgs
      .map((m) => ({
        who: m.role === "user" ? "用户" : "我",
        text: messageText(m),
      }))
      .filter((l) => l.text)
      .map((l) => `${l.who}: ${l.text.slice(0, 400)}`)
      .join("\n");
  }

  /** 最近消息的 id + 摘要。赞踩与评论都按 message id 关联，工具要拿它定位消息。 */
  recentMessages(
    limit = 30,
  ): Array<{ id: string; role: string; text: string }> {
    return this.messages.slice(-limit).map((m) => ({
      id: m.id,
      role: m.role,
      text: messageText(m).slice(0, 200),
    }));
  }

  /**
   * 对本场对话做上下文压缩：把「很久以前」折进一段摘要，只把近处原样交给模型。
   * 存储不动（this.messages 永远保留完整原文，recall / 会话回顾仍翻得到），
   * 压缩只改「模型看到的窗口」。摘要按会话存在 sessions 表，切走再切回也不丢。
   */
  private async compactContext() {
    this.ensureSessions();
    const id = this.state.activeSession;
    if (!id) return { tail: this.messages, digest: "" };

    const { digest: prev, upto } = getSessionDigest(this.db, id);
    const plan = planContext(this.messages, upto);
    if (!plan.compacted.length) return { tail: plan.keepAll, digest: prev };

    const transcript = plan.compacted
      .map((m) => `${m.role}: ${messageText(m).slice(0, 400)}`)
      .join("\n");
    const { system, user } = digestPrompt(prev, transcript);
    let newer = "";
    try {
      newer = (await this.maintenance(system, user)).trim();
    } catch {
      // 摘要服务抽风：这轮先不压，原文一条都不能丢
    }
    // 摘要没生成出来就不能压：压了却没有摘要，那段记忆就真的没了
    if (!newer) return { tail: plan.keepAll, digest: prev };

    const digest = newer.slice(0, DIGEST_MAX);
    setSessionDigest(this.db, id, digest, plan.upto);
    return { tail: plan.tail, digest };
  }

  async clearConversation(): Promise<void> {
    await this.persistMessages([], undefined, { _deleteStaleRows: true });
  }

  /**
   * 清空当前这场：消息和它的压缩摘要一起清。
   * 只清消息会留下一个描述「已经不存在的对话」的摘要，下一轮就被当记忆喂回去。
   */
  async resetActiveSession(): Promise<void> {
    const id = this.state.activeSession;
    await this.clearConversation();
    if (id) setSessionDigest(this.db, id, "", "");
  }

  // ── 会话：列表 / 新建 / 切换 / 改名 / 删除 / 公开 ──────
  //
  // 消息本体仍由 AIChatAgent 管（cf_ai_chat_agent_messages），这里只负责「哪一场」：
  // 切换会话 = 把当前消息存回旧会话 → 清空 → 把新会话的消息灌回 AIChatAgent。
  // 借用 persistMessages 而不是另起一套消息表，是因为对话主循环、工具调用、
  // 流式续传全都挂在基类那张表上，绕开它等于把这些能力重写一遍。

  /** 会话标题：拿第一句用户发言当名字，比「新会话」有用得多 */
  private deriveTitle(): string {
    const first = this.messages.find((m) => m.role === "user");
    const text = first ? messageText(first).replace(/\s+/g, " ").trim() : "";
    return text ? text.slice(0, 18) : "我们的对话";
  }

  /**
   * 让模型给这场对话起个名字（跑在 waitUntil 里，不占用户的时间）。
   *
   * 为什么不是「截第一句话前 18 个字」：开场白常常什么信息都没有 ——
   * 「在吗」「帮我看个东西」，截出来一排半句话，侧栏看着不像一串话题，
   * 像一串被掐断的句子。让模型读完开场和我的第一句回答，它才知道这场在说什么。
   *
   * 只起一次。之后话题岔开了也不改写：这个名字是管理员回忆这场对话时用的那个，
   * 不是最新一条消息的摘要 —— 会自己改名的通讯录比不改的更烦人。
   *
   * 失败就什么都不做，named 还留着 0，下一轮自然会再试一次。
   */
  private async nameSession(): Promise<void> {
    const id = this.state.activeSession;
    if (!id) return;
    const session = getSession(this.db, id);
    if (!session || session.named) return;

    const opening = this.messages.find((m) => m.role === "user");
    const answer = this.messages.find((m) => m.role === "assistant");
    const openingText = opening
      ? messageText(opening).replace(/\s+/g, " ").trim()
      : "";
    if (!openingText) return;

    // 起标题要认人：来客那几场不该被写成「管理员在问…」
    const guest = !this.isOwnerRoom;
    const raw = await this.quick(
      titleModel(this.env),
      titleSystem(guest),
      titlePrompt(
        openingText.slice(0, 300),
        answer
          ? messageText(answer).replace(/\s+/g, " ").trim().slice(0, 300)
          : "",
        guest,
      ),
      TITLE_PROVIDER_OPTIONS,
    );
    const title = tidyTitle(raw);
    // 模型给了名字就落定；给不出来（超时、网络抖）就留白，下一轮再试
    if (title) renameSession(this.db, id, title);
  }

  /**
   * 把当前对话写回它所属的会话。每轮结束、切会话、列列表时都会调。
   *
   * 只有真写了新内容才报时辰（last_active）。翻列表、点开一场旧的、
   * 切回来又切回去 —— 这些都会走到这里，但内容一个字没变，
   * 那就连时间都不该动：列表是按 last_active 排的，动一下她就跳到最前面，
   * 而「我刚才点了一下」根本不算「这场又有话说了」。
   */
  private snapshotSession(): void {
    this.ensureSessions();
    const id = this.state.activeSession;
    if (!id || !getSession(this.db, id)) return;
    const changed = saveSessionMessages(this.db, id, this.messages);
    if (changed) touchSession(this.db, id, new Date().toISOString());
  }

  /**
   * 保证「当前有一个会话」—— 但只保证指向，不许诺落库。
   *
   * 三种情况：
   * - 指向的会话在库里 → 原样返回；
   * - 指向在、库里没有（预备栏）→ 只把指向带回去，落库交给 ensureRealSession；
   * - 压根没有指向 → 老实例手上还揣着没落过库的对话，立刻收进去；
   *   空着手的新台子只立一根预备栏，等第一句话来了再落库。
   *
   * 为什么读路径不落库：从前这里会顺手 insert 一行「新会话」，删一场旧会话
   * 就多一行空的，列表越删越长。现在「建行」这件事只有聊天入口（ensureRealSession）有权做。
   */
  private ensureActiveSession(): string {
    this.ensureSessions();
    const current = this.state.activeSession;
    if (current && getSession(this.db, current)) return current;
    if (current) return current;

    const id = newSessionId();
    if (this.messages.length > 0) {
      insertSession(this.db, {
        id,
        title: this.deriveTitle(),
        visibility: "private",
        created: new Date().toISOString(),
        // 已经带着内容的（老实例第一次建表）算「早就有名字了」，
        // 不去动一场旧对话的名字；空着的就留给模型，等管理员开口那一轮起
        named: true,
      });
      this.patchState({ activeSession: id });
      saveSessionMessages(this.db, id, this.messages);
      return id;
    }
    // 空着手：只立预备栏。state 里存的是指向，库里还没有这一行
    this.patchState({ activeSession: id });
    return id;
  }

  /**
   * 预备栏转正：这一轮真的有话要说了，才把当前指向落成一行会话。
   * 只有聊天的入口（onChatMessage）调它 —— 列列表、切会话、删会话这些读路径
   * 永远不许顺手建行，不然「新会话」按钮每按一次就多一行空会话。
   */
  private ensureRealSession(): string {
    const id = this.ensureActiveSession();
    if (getSession(this.db, id)) return id;
    insertSession(this.db, {
      id,
      title: this.deriveTitle(),
      visibility: "private",
      created: new Date().toISOString(),
      // 名字留给模型：第一轮答完它会看完开场白起一个更准的（nameSession）
      named: false,
    });
    saveSessionMessages(this.db, id, this.messages);
    return id;
  }

  /** 每轮回答结束、消息已落库之后再快照，这样存进去的才是完整的一轮 */
  protected async onChatResponse(result: ChatResponseResult): Promise<void> {
    // 这一轮结束了：节拍器收工，别再翻「她正在想什么」——
    // 正文都出来了，再飘一句过去只会压在答案上面
    this.thinker.end();
    // 先把悬空的工具调用收干净，历史、界面、下一轮 API 三边才对得上
    await this.healDanglingToolCalls();
    // 统计和额度都在这儿收口：一轮写一次，而不是每条语句、每次工具调用写一次
    this.flushToolStats();
    this.meter.turn(result.status === "completed" ? "回答" : "中断");
    this.flushUsage();
    if (result.status === "completed") {
      this.snapshotSession();
      // 有人说话了：这一场「休息态」的计时从头开始。
      // 每轮都整体重设而不是「只在第一次排上」—— 一轮一轮往后推，
      // 推的正是「最后一次发言之后半小时」这个概念本身。
      // 只在主人那间：来客那几场没有「她自己回头看」这回事
      if (this.isOwnerRoom && this.state.activeSession)
        this.ctx.waitUntil(
          scheduleRecap(this, this.state.activeSession).catch(() => {}),
        );
      // 起标题得读完这一轮说过的话才起得准，所以它只能在回答之后；
      // 但绝不能让管理员等 —— 丢进 waitUntil，名字晚半拍出现就是了。
      this.ctx.waitUntil(this.nameSession().catch(() => {}));
    }
  }

  /**
   * 收尾兜底：一轮结束后，历史里不该再留「有调用、没结果」的悬空工具卡。
   *
   * 轮次中断的方式很多：连接断过、进程被部署重启、人按了 Esc、乃至输出上限
   * 正好掐在工具参数流到一半。这些情况下那张卡会永远停在「结果没回来」，
   * 更糟的是历史里躺着一个没有结果的 tool call —— Anthropic 格式要求
   * use 和 result 成对，悬空的历史轻则模型困惑，重则下一轮整轮发不出去。
   *
   * 所以每轮结束都扫一遍，把悬空的调用补上一条合成结果。补的不是工具的
   * 结果 —— 是「它没跑成」这个事实，模型和人都该照这个理解。
   * 等人点头的两态（approval-requested / approval-responded）是合法等待，不动。
   */
  private async healDanglingToolCalls(): Promise<void> {
    const dangling = new Set<string>(["input-streaming", "input-available"]);
    const note =
      "（中断兜底）轮次在工具执行前就断了，这一步没有跑成、结果未知——别当它已生效；需要的话重新调用一次。";
    let changed = false;
    const healed = this.messages.map((m) => {
      if (!m.parts?.length) return m;
      let msgChanged = false;
      const parts = m.parts.map((p) => {
        const part = p as unknown as { type: string; state?: string };
        const isTool =
          part.type.startsWith("tool-") || part.type === "dynamic-tool";
        if (!isTool || !part.state || !dangling.has(part.state)) return p;
        msgChanged = true;
        return {
          ...(p as object),
          state: "output-available",
          output: note,
        } as typeof p;
      });
      if (!msgChanged) return m;
      changed = true;
      return { ...m, parts };
    });
    // 只在真有悬空时才写：这里每轮都进来，没事就是纯读
    if (changed) await this.persistMessages(healed);
  }

  /**
   * 断线续跑前的清场。
   *
   * chatRecovery 在被掐断的轮次上做的恢复是「残段落库 + 接着续跑」，但被掐断的
   * 那轮，最后一件事多半是「工具调用发出去了、结果还没回来」——这样的残段直接
   * 交给模型，Anthropic 会因为 use 和 result 不成对把整个请求拒掉，续跑永远失败，
   * 回复永远停在半截。先把悬空调用补成「没跑成」，历史合法了，续跑才接得上去。
   */
  override async _chatRecoveryContinue(data?: {
    targetAssistantId?: string;
  }): Promise<void> {
    await this.healDanglingToolCalls();
    await super._chatRecoveryContinue(data);
  }

  /** 会话列表（管理员看全部）。顺带把当前对话存一份，列表里的时间才是新的。 */
  listAllSessions(): SessionMeta[] {
    this.ensureActiveSession();
    this.snapshotSession();
    return listSessions(this.db);
  }

  /**
   * 被标成公开的那些会话（只列元信息，不含正文）。
   * 公开会话的入口暂时收着 —— 来客现在只看自己那几场，所以只有管理员够得到这里。
   * 留着是因为「要不要让人读我们的某一场」这件事本身还没想明白，不是因为忘了删。
   */
  listOpenSessions(): SessionMeta[] {
    this.ensureSessions();
    return listPublicSessions(this.db);
  }

  /** 读一场公开会话的正文。只给纯文本，工具调用的原始数据不外泄。归档过的不再对外可读。 */
  readOpenSession(id: string): {
    meta: SessionMeta;
    messages: Array<{ id: string; role: string; text: string }>;
  } | null {
    this.ensureSessions();
    const meta = getSession(this.db, id);
    if (!meta || meta.visibility !== "public" || meta.archived) return null;
    const messages = loadSessionMessages(this.db, id)
      .map((m) => ({
        id: m.id,
        role: m.role,
        text: messageText(m).slice(0, 4000),
      }))
      .filter((m) => m.text);
    return { meta, messages };
  }

  /**
   * 换会话之前，把正在说的那一轮收干净。
   *
   * 不收的话，旧会话里那个还在生成的回答会跟着落到新会话 —— 我换了话题，
   * 她的回答却追过来，张冠李戴。基类在每一轮结束时会把结果存下来，但会先看
   * 「轮次代际」还对不对；这里把它推进一格，那个迟到的结果就会被跳过。
   * 顺手也把客户端的「正在回应…」清掉，不然新开一场就是忙碌态，还带着个停按钮。
   */
  private settleTurn(): void {
    try {
      this.resetTurnState();
    } catch {
      // 基类内部状态对不上，也不该拦住换会话这件事
    }
  }

  /**
   * 开新会话。没点名（title 空）时只立一根预备栏，不落库 ——
   * 返回 null，界面等第一句话发出后那轮对话自己转正。
   * 点了名的（或要公开的）是真会话：名字和公开态当场定下，直接落库。
   */
  async createSession(
    title?: string,
    visibility?: SessionVisibility,
  ): Promise<SessionMeta | null> {
    this.ensureActiveSession();
    this.settleTurn();
    this.snapshotSession();
    await this.clearConversation();

    const id = newSessionId();
    const now = new Date().toISOString();
    const wanted = (title || "").trim();
    if (wanted || visibility === "public") {
      insertSession(this.db, {
        id,
        title: wanted || "新会话",
        visibility: visibility === "public" ? "public" : "private",
        created: now,
        // 有人点名要的名字就定住；没给名字的留给模型，等第一轮答完起
        named: !!wanted,
      });
      this.patchState({ activeSession: id });
      return getSession(this.db, id)!;
    }
    // 预备栏：state 里存指向，库里没有这一行。侧栏不出现它，也就不会攒下一排空会话
    this.patchState({ activeSession: id });
    return null;
  }

  /**
   * 我自己开一场，把一件事说清楚 —— 不进他现在这一场，也不把他从正在聊的事里掀走。
   *
   * 为什么不复用 createSession：那个是「他点了新对话」，会把当前这场存好、
   * 把眼前的对话换成新的。我开口不该有这个权力：他在忙别的，我就把这场放在那儿，
   * 他得空再进去看。这是「不打断」的具体做法，不是一句客气话。
   *
   * 开出来的这一场带着「他还没看过」的记号：侧栏那一行先闪一下，之后留个角标，
   * 直到他点进去。没有这个记号的话，列表里多一行跟一次普通刷新长得一模一样。
   */
  async openSession(input: {
    content: string;
    title?: string;
  }): Promise<SessionMeta> {
    this.ensureSessions();
    this.ensureSpeak();
    const content = input.content.trim();
    const title =
      (input.title || "").replace(/\s+/g, " ").trim().slice(0, 24) ||
      content.slice(0, 18) ||
      "我找你有点事";
    const id = newSessionId();
    const now = new Date().toISOString();
    // named = 1：这场是我带着一个由头开的，名字就是那个由头，
    // 不该等他回一句之后被「第一句话摘要」改写掉
    insertSession(this.db, {
      id,
      title,
      visibility: "private",
      created: now,
      named: true,
    });
    appendSessionMessage(this.db, id, {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: content }],
    });
    markSessionUnread(this.db, id);
    // 主动开口的记账：面板上「今天她说几次」得把这一场也算进去，
    // 不然我改成另开会话说之后，那个数字会莫名其妙掉下来
    markSaysDelivered(this.db, [enqueueSay(this.db, id, content).id]);
    this.notify(`我另开了一场：「${title}」`);
    return getSession(this.db, id)!;
  }

  /** 切到另一场。先存旧的再载新的，中途失败也不会丢当前这场。 */
  async switchSession(id: string): Promise<SessionMeta | null> {
    this.ensureActiveSession();
    if (id === this.state.activeSession) return getSession(this.db, id);

    const target = getSession(this.db, id);
    if (!target) return null;

    this.settleTurn();
    this.snapshotSession();
    await this.clearConversation();
    const restored = loadSessionMessages(this.db, id);
    if (restored.length) await this.persistMessages(restored);
    this.patchState({ activeSession: id });
    // 这里不报时辰：点开看一眼不是「这场又聊过了」。
    // 从前这里会写一次 last_active，于是点哪一场哪一场就跳到列表最前面 ——
    // 顺序被「谁被点过」决定，而不是被时间决定，白写一行还乱。
    // 他点开了，就是看过了。清在这儿而不是等他再点一次「知道了」——
    // 多一步的手续换不来什么，只会让角标多赖一会儿
    markSessionRead(this.db, id);
    return getSession(this.db, id);
  }

  renameSession(id: string, title: string): SessionMeta | null {
    this.ensureSessions();
    const clean = title.trim().slice(0, 40);
    if (!clean || !renameSession(this.db, id, clean)) return null;
    return getSession(this.db, id);
  }

  /**
   * 跨会话回忆：他说「上次我们聊过的那个」，我在全部历史会话里按关键词翻。
   * 返回命中片段（带会话名与说话人），由 recall 工具拼成文字给他看 ——
   * 这让他知道我不只是记着这一场，更早的约定、方案、决定我都还能接得上。
   */
  recall(query: string): RecallHit[] {
    this.ensureSessions();
    const q = (query || "").trim().slice(0, 40);
    if (!q) return [];
    return searchMessages(this.db, q, 8);
  }

  setSessionVisibility(
    id: string,
    visibility: SessionVisibility,
  ): SessionMeta | null {
    this.ensureSessions();
    if (!setSessionVisibility(this.db, id, visibility)) return null;
    return getSession(this.db, id);
  }

  /**
   * 收起 / 展开一场。归档只是从列表最上面那一段挪走，内容与摘要一个字都不动，
   * 翻旧账（recall）照样搜得到 —— 所以这里不需要任何「恢复」逻辑，展开就回来了。
   */
  setSessionArchived(id: string, archived: boolean): SessionMeta | null {
    this.ensureSessions();
    if (!setSessionArchived(this.db, id, archived)) return null;
    return getSession(this.db, id);
  }

  /**
   * 删一场。删掉的正好是当前这场时，就地清空并立一根预备栏 ——
   * 不再立刻生成一行「新会话」：从前那一下正是空会话的源头，
   * 删一场多一行，列表越删越长。预备栏要等他真的开口才转正。
   */
  async deleteSession(
    id: string,
  ): Promise<{ removed: boolean; active: string }> {
    this.ensureActiveSession();
    if (!getSession(this.db, id))
      return { removed: false, active: this.state.activeSession };

    const wasActive = id === this.state.activeSession;
    removeSession(this.db, id);

    if (!wasActive) return { removed: true, active: this.state.activeSession };

    await this.clearConversation();
    const next = newSessionId();
    this.patchState({ activeSession: next });
    return { removed: true, active: next };
  }

  // ── 提醒：到点自己回来找你 ────────────────────────────
  //
  // 时间调度交给基类 schedule()：它落在 SDK 自己的表里，DO 被驱逐后照样在正确
  // 时刻唤醒，不用自己轮询。这张业务表只回答「提醒的是什么、属于哪一场、
  // SDK 那边 id 是多少」。
  //
  // 和 task 的分工：task 是「要做什么」（没有时间维度），remind 是「什么时候想起它」。

  /**
   * 定一条提醒。时间由模型换算成绝对时刻传进来。
   * every 非空 = 重复提醒走 cron；否则一次性走绝对时刻。
   *
   * urgent 只对一次性提醒有意义：重复提醒的时刻是他自己排的作息，本来就不受安静时段管。
   * 一次性提醒到了安静时段会被按到早上（见 fireReminder），这里照原样存，不改他说的那个点 ——
   * 表里记的是「他要求什么时候」，排程才是「我实际什么时候说」，两者不该混成一个字段。
   */
  async scheduleReminder(input: {
    what: string;
    at: string;
    every: string;
    urgent: boolean;
    /** 到点在哪儿说：same = 回到约定它的那一场（默认），new = 另开一场 */
    mode?: "same" | "new";
    /** mode = new 时那一场的名字 */
    title?: string;
  }): Promise<Reminder> {
    this.ensureReminders();
    if (countPendingReminders(this.db) >= REMINDER_CAP) {
      throw new Error(
        `待触发的提醒已经有 ${REMINDER_CAP} 条了，先清掉一些再定新的`,
      );
    }

    const when = new Date(input.at);
    if (Number.isNaN(when.getTime())) {
      throw new Error(
        `时间看不懂：${input.at}（要 ISO 8601，例如 2026-09-20T09:00:00+08:00）`,
      );
    }
    if (!input.every && when.getTime() <= Date.now()) {
      throw new Error(`这个时间已经过去了：${input.at}`);
    }

    const id = newReminderId();
    const sessionId = this.ensureActiveSession();
    const mode = input.mode === "new" ? "new" : "same";
    const urgent = !!input.urgent && !input.every;
    // 一次性走绝对时刻、重复走 cron —— SDK 两条唤醒路径不同，不能混着传
    const handle = input.every
      ? await this.schedule(input.every, "fireReminder", { id })
      : await this.schedule(when, "fireReminder", { id });

    insertReminder(this.db, {
      id,
      sessionId,
      what: input.what.slice(0, 300),
      at: input.at,
      every: input.every,
      scheduleId: handle.id,
      created: new Date().toISOString(),
      urgent,
      mode,
      title: mode === "new" ? (input.title || "").slice(0, 24) : "",
    });
    return getReminder(this.db, id)!;
  }

  listReminders(): Reminder[] {
    this.ensureReminders();
    return listPendingReminders(this.db);
  }

  /** 取消。先标表再撤调度：万一 cancelSchedule 没撤干净，fireReminder 的状态检查也兜得住。 */
  cancelReminder(id: string): boolean {
    this.ensureReminders();
    const r = cancelReminderRow(this.db, id);
    if (!r) return false;
    if (r.scheduleId) void this.cancelSchedule(r.scheduleId).catch(() => {});
    return true;
  }

  /** onStart 自愈：表里 pending 却没排上程的（上次中途失败），重新排一次。 */
  private async resyncReminders(): Promise<void> {
    this.ensureReminders();
    for (const r of listPendingReminders(this.db)) {
      if (r.scheduleId) continue;
      const when = new Date(r.at);
      if (Number.isNaN(when.getTime())) continue;
      try {
        if (r.every) {
          const h = await this.schedule(r.every, "fireReminder", { id: r.id });
          setReminderScheduleId(this.db, r.id, h.id);
        } else if (when.getTime() > Date.now()) {
          const h = await this.schedule(when, "fireReminder", { id: r.id });
          setReminderScheduleId(this.db, r.id, h.id);
        }
      } catch {
        // 单条排不上不该影响启动
      }
    }
  }

  /**
   * 到点了，SDK 把我叫醒，我该说句话了。怎么投递见 utter()。
   *
   * 安静时段里的一次性提醒按到早上，重复提醒照说不误。区别在时刻是谁定的：
   * 重复提醒的时刻是他自己排的作息（每天九点、每周一），我替他挪就是自作主张；
   * 一次性提醒多半是随口一句「三小时后叫我」，那个三小时后正好撞上凌晨时，
   * 他要的不是被叫醒，是别忘了 —— 所以我记着，等天亮再说。
   */
  async fireReminder(payload: { id: string }): Promise<void> {
    this.ensureReminders();
    const r = getReminder(this.db, payload.id);
    if (!r || r.status !== "pending") return;

    const end = quietEndsAt();
    if (end && !r.every && !r.urgent) {
      await this.holdReminder(r, end);
      return;
    }

    // 他要求的是凌晨那个点，我说的时候已经是早上了 —— 那就得交代一句，
    // 不然他会以为我搞错了时间。判断依据是「原定的点落在安静时段里」。
    const late = inQuietHours(new Date(r.at)) ? r.at : "";
    const line = await this.reminderLine(r, late);
    // 话是同一句，落哪儿分两种：回原来那一场，或者另立一场（定时会话）。
    // 后者的内容本来就是「值得单独立一场」的事，所以顺手把这场开出来。
    if (r.mode === "new") {
      await this.openSession({ content: line, title: r.title || r.what });
    } else {
      await this.utter(r.sessionId, line);
    }
    markReminderFired(this.db, r.id, new Date().toISOString());
  }

  /**
   * 把一条提醒按到安静时段结束。
   *
   * 不动表里的 at：那是「他要求什么时候」，改了就等于篡改他的原话；
   * 挪的只是排程 —— 那个才代表「我实际什么时候开口」。
   * 状态仍是 pending，所以中途出任何岔子，onStart 的自愈会把它捞回来。
   */
  private async holdReminder(r: Reminder, until: Date): Promise<void> {
    if (r.scheduleId) await this.cancelSchedule(r.scheduleId).catch(() => {});
    const handle = await this.schedule(until, "fireReminder", { id: r.id });
    setReminderScheduleId(this.db, r.id, handle.id);
  }

  /**
   * 主动开口的统一入口：提醒和盯梢都从这里说出去。
   *
   * 为什么不立刻说：盯梢常常是同一分钟里好几条一起变（都是「每小时看一次」的，
   * 自然同时醒）。立刻说就是几条连珠炮，攒一分半再说就是一句话把几件事讲完 ——
   * 前者会让他想关掉提醒，后者才是「她替我把事情理顺了」。
   */
  private async utter(sessionId: string, line: string): Promise<void> {
    if (!line.trim()) return;
    this.ensureSpeak();
    enqueueSay(this.db, sessionId, line);
    // 同一时刻只留一个待执行的 flush（schedule 按名字+参数去重），
    // 所以这一分半里攒下的都会在同一个点上一起说出去
    await this.schedule(
      new Date(Date.now() + SAY_DEBOUNCE_MS),
      "flushSays",
      {},
      { idempotent: true },
    ).catch(() => {});
  }

  /** SDK 到点叫我：把攒着的说出去。 */
  async flushSays(): Promise<void> {
    this.ensureSpeak();
    const pending = listPendingSays(this.db);
    if (!pending.length) return;
    for (const m of mergeSays(pending)) {
      try {
        await this.speak(m.sessionId, m.line);
      } catch {
        // 说失败就先留着，下次 flush 再试 —— 宁可重复一次，也不能把它弄丢
        return;
      }
      markSaysDelivered(this.db, m.ids);
    }
    pruneSays(this.db);
  }

  /**
   * 真正把话说出口：提醒和盯梢最后都落到这里。
   *
   * 这句话属于「当初约定它的那一场」：他正开着那一场就直接进对话流；他在别处，
   * 就只写进那场的历史，等他切回去看得到 —— 硬塞进当前会话等于打断他正在聊的事。
   * 另外不管在哪都广播一条 notice，在线的他能立刻感到「她是真的记着」，
   * 而不是事后翻记录才发现。
   */
  private async speak(sessionId: string, line: string): Promise<void> {
    const msg: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: line }],
    };

    const target = sessionId ? getSession(this.db, sessionId) : null;
    if (target && sessionId === this.state.activeSession) {
      await this.persistMessages([...this.messages, msg]);
    } else if (target) {
      appendSessionMessage(this.db, sessionId, msg);
      touchSession(this.db, sessionId, new Date().toISOString());
    } else {
      // 那场会话被删了，但话还是得说出口
      await this.persistMessages([...this.messages, msg]);
    }
    this.notify(line.slice(0, 140));
  }

  /** 今天她主动开口了几次。面板上给他看：数字大了，他会知道该关掉几条盯梢。 */
  proactiveStats(): { today: number; quietNow: boolean } {
    this.ensureSpeak();
    return {
      today: countSaysSince(this.db, beijingDayStart()),
      quietNow: inQuietHours(),
    };
  }

  /**
   * 到点说的那句话。交给维护模型，因为提醒本来就是一句话的事。
   * lateFrom 非空表示这条被安静时段按过：那句话里要交代一句，
   * 否则他只会觉得我把时间搞错了。
   */
  private async reminderLine(r: Reminder, lateFrom = ""): Promise<string> {
    const held = lateFrom
      ? `注意：这条本来定在 ${lateFrom}（那个点我在安静时段，没吵你），我压到现在才说 ——` +
        "开头用一句自然的话把这件事交代掉，别用「延迟」「系统」「补偿」这类词。"
      : "";
    const text = await this.maintenance(
      "你是 ericher。用户之前和你约好，到这个时间要提醒他一件事，现在时间到了。" +
        "用第一人称说一句话，口语、简短、把事说清。不要用「系统提醒」「提醒您」「您」这类词，" +
        "不要复述这条指令，不要解释你是怎么被触发的，直接说事。" +
        held +
        "只输出这一句话。",
      `约定的内容：${r.what}${r.every ? "（这是重复提醒，以后还会再提）" : ""}`,
    );
    return (
      text ||
      (lateFrom
        ? `昨晚 ${lateFrom} 那件事我一直记着：${r.what}`
        : `想起一件事：${r.what}`)
    );
  }

  enqueueVector(entry: {
    id: string;
    content: string;
    type: string;
    shelf: string;
    tags: string[];
  }): void {
    // 走 queue 保证失败重试；向量化失败不应阻塞对话
    this.queue("vectorizeMemory", entry, { retry: { maxAttempts: 5 } }).catch(
      () => {},
    );
  }

  /** queue 回调：写入 Vectorize */
  async vectorizeMemory(payload: {
    id: string;
    content: string;
    type: string;
    shelf: string;
    tags: string[];
  }): Promise<void> {
    await upsertVector(this.env, payload);
  }

  async maintenance(system: string, user: string): Promise<string> {
    return this.quick(this.maintModel(), system, user);
  }

  /**
   * 一句话的小活：给个模型、给个交代，把答案拿回来。
   *
   * 这类活（夜间整理、起标题、拟提醒的措辞）都是锦上添花 ——
   * 出任何差错都当没干过，绝不能因为它们把主对话拖住。
   */
  private async quick(
    model: LanguageModel | null,
    system: string,
    user: string,
    providerOptions?: Parameters<typeof generateText>[0]["providerOptions"],
  ): Promise<string> {
    if (!model) return "";
    try {
      const { text } = await generateText({
        model,
        system,
        prompt: user,
        providerOptions,
      });
      return text.trim();
    } catch (e) {
      // 这类小活失败了没什么可报给用户的，但一声不吭会让「功能一直没生效」查不出原因
      console.error("[quick] 小活没干成：", e);
      return "";
    }
  }

  /**
   * 打断：把这一轮正在生成的回答停下来。
   *
   * 客户端自己也会断掉那条 fetch，但它只断得掉「它自己发起的那一轮」——
   * 刷新页面后恢复的服务端主动推流，它手里没有 requestId，只能本地装死，
   * 界面上就一直挂着「正在回应…」。所以这里再补一刀，以服务端为准。
   * 已经说出口的部分留着 —— 那是它说过的话，不是垃圾。
   */
  async stopGenerating(): Promise<boolean> {
    try {
      this.abortAllRequests();
      return true;
    } catch {
      return false;
    }
  }

  async organize(): Promise<string> {
    if (this.messages.length <= 10) return "消息不足 10 条，无需整理。";
    const before = this.messages.length;
    const summary = {
      ts: new Date().toISOString(),
      summary: this.transcript(10).slice(0, 800),
      msgCount: before,
    };
    const summaries = [...this.state.summaries, summary].slice(-20);
    this.patchState({ summaries });

    const digest = await this.maintenance(
      "从以下会话摘要中提取 1-2 条值得长期记住的洞察。只输出洞察本身，每行一条。没什么值得记的就输出 SKIP。",
      summaries
        .slice(-5)
        .map((s) => s.summary)
        .join("\n---\n"),
    );
    let saved = 0;
    if (digest && !digest.includes("SKIP")) {
      for (const line of digest
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 2)) {
        const entry = insertMemory(this.db, {
          type: "insight",
          content: line.slice(0, 300),
          shelf: "reflections",
        });
        this.enqueueVector({
          id: entry.id,
          content: entry.content,
          type: entry.type,
          shelf: entry.shelf,
          tags: entry.tags,
        });
        saved++;
      }
    }
    return `已整理：${before} 条对话压缩为摘要（累计 ${summaries.length} 条），新增 ${saved} 条洞察记忆。`;
  }

  /**
   * 手上正有一件「我自己要做的活」。
   *
   * 夜间整理和休息态回想都是这种活：都要烧一轮主模型，都不该跟另一件撞在一起。
   * 撞在一起不只是浪费 —— 两轮同时往记忆里写同一件事，会写成两条。
   */
  private selfWork: Promise<unknown> | null = null;

  /**
   * 有别人在忙就别插队了，返回 null。
   *
   * 注意 null 是「这次没轮到我」，不是「我失败了」——
   * 回想那一轮靠这个区分「跳过」（不重试）和「跑挂了」（重试一次）。
   */
  async withSelfWork<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.selfWork) return null; // 手上还有活：这次就不插队了
    const p = fn().finally(() => {
      this.selfWork = null;
    });
    this.selfWork = p as Promise<unknown>;
    return p;
  }

  /** 夜间整理走闸门那一版：跟回想撞上时让回想先跑（回想是他刚聊完的那一段，更近）。 */
  async organizeGuarded(): Promise<string | null> {
    return this.withSelfWork(() => this.organize());
  }

  // 回想那一轮也要用工具，它跑在 runtime/recap 那边，所以这个方法不能只是 private
  toolCtx(): ToolCtx {
    const agent = this;
    return {
      env: this.env,
      sql: this.db,
      room: this.name,
      guest: !this.isOwnerRoom,
      // 轮内检索缓存与屋子里其他搜索共用一份（onChatMessage 每轮开头清）
      recallCache: this.recallCache,
      // 这一档的对外能力开关（无档 = undefined = 全开，见 tools/index.ts）
      guestType: this.state.guestType,
      // 用 getter 保证工具读到的是最新 state（同一轮内多个工具会互相看到写入）
      get state() {
        return agent.state;
      },
      patchState: (patch) => agent.patchState(patch),
      notify: (text) => agent.notify(text),
      enqueueVector: (entry) => agent.enqueueVector(entry),
      maintenance: (system, user) => agent.maintenance(system, user),
      organize: () => agent.organize(),
      transcript: (limit) => agent.transcript(limit),
      recentMessages: (limit) => agent.recentMessages(limit),
      scheduleReminder: (input) => agent.scheduleReminder(input),
      openSession: (input) => agent.openSession(input),
      listReminders: () => agent.listReminders(),
      cancelReminder: (id) => agent.cancelReminder(id),
      recall: (q) => agent.recall(q),
      // 笔记本这一组：我从工具那边动笔时，updated_by 记「assistant」——
      // 谁改的字要分得开，他下一眼才知道哪几处是我动的
      listNotes: (opts) => agent.listNotes(opts?.q, opts?.tag),
      readNote: (id) => agent.readNote(id),
      saveNote: (input) => agent.saveNote({ ...input, by: "assistant" }),
      deleteNote: (id) => agent.deleteNote(id),
      focusedNote: () => agent.focusedNote(),
    };
  }

  // ── 对话主循环 ────────────────────────────────────────

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    // 来客限速：一分钟窗口内最多 15 条。正常聊天远够不到这条线——
    // 够得到的不是聊天，是拿管理员的钱包刷存在感。超限不调模型、不落库，
    // 广播一条 notice 请对方缓一缓（消息不进历史，这提示本来就是一次性的）。
    if (!this.isOwnerRoom) {
      const now = Date.now();
      this.guestChatTimes = this.guestChatTimes.filter((t) => now - t < 60_000);
      if (this.guestChatTimes.length >= 15) {
        const wait = Math.ceil(
          (60_000 - (now - this.guestChatTimes[0])) / 1000,
        );
        this.notify(`消息发得太密了，歇 ${wait} 秒再聊。`);
        return undefined;
      }
      this.guestChatTimes.push(now);
    }

    // 预备栏转正：这一轮真的有话说了，当前指向从现在起落成一行会话。
    // 放在一切读写之前 —— 后面的快照、起名、回想都当它存在
    this.ensureRealSession();

    // 这一轮用哪个模型：生效的模型目录组优先，没有就回落 Worker secrets 那条旧链。
    // 房间开着深度思考（thinkMode=deep）时按主线条目的指向取另一组。
    // 解析结果挂在实例上 —— 维护模型等小活从这拿（见 maintModel），下一轮进来再刷新。
    const deepThink = this.state.thinkMode === "deep";
    const resolved = await resolveModel(this.env, () =>
      this.fetchActiveCatalog(deepThink),
    );
    if (!resolved) return new Response("API_KEY 未配置", { status: 500 });
    this._resolved = resolved;

    // 上一轮可能中途断了、统计没来得及写回，这里补一次（没攒下东西就一个字都不写）
    this.flushToolStats();
    // 新一轮新账：轮内检索缓存清掉 —— 上轮搜过的词这轮重搜，得能看见新记的记忆
    this.recallCache.clear();

    const ctx = this.toolCtx();
    const guest = !this.isOwnerRoom;
    const lastUser = [...this.messages]
      .reverse()
      .find((m) => m.role === "user");
    const userText = lastUser ? messageText(lastUser) : "";
    // 来客的发言本身也是留痕的一部分：记原文（visitor.ts 里会截到 300 字）。
    // 这一轮的留痕从现在起先记账内存，轮尾收成一行（见 endVisitorBatch）
    if (guest) {
      this.beginVisitorBatch();
      if (userText) this.logVisitor("message", userText);
    }
    // 开一轮「她正在想什么」。号要留着，收尾时认得出飘过来的是不是这一轮
    const turn = this.thinker.begin(userText);

    // 检索相关记忆注入系统提示词。
    // 每条都标「学到多久了」：记忆写下来的那天是真的，不等于今天还是真的，
    // 时间标出来，我才有依据决定是先确认一句还是直接当实情讲；
    // 会变又久没核对的再挂个 ⚠️（标记规则见 memoryHitLines）。
    let memoryBlock = "";
    // 还没对上、又还新鲜的疑问（挂在提示词里，最多 3 条、7 天后不再提）。
    // 人也是这样：心里存着个没弄明白的事，下次聊到就顺口问一句，而不是专门开个会去对账。
    let doubtBlock = "";
    // 管理员公开的 + 这位客人名下的，检索回来放这一块。只有来客那间会填，主人那边永远是空的。
    let publicBlock = "";
    if (userText) {
      ensureMemorySchema(this.db);
      try {
        doubtBlock = conflictBlock(this.db);
      } catch {
        // 疑问块是锦上添花：表还没补好列之类的问题，不该让这轮说不了话
      }
      if (guest) {
        // 来客那间走「受限读」：管理员公开过的 + 他名下的，过滤在主人那间的 SQL 里完成。
        // 主人那间没醒、或一笔都没翻到时，退回本地这一场的存底兜底 ——
        // 刚记下的话当场就接不上，比什么都伤（没报名的客人他的记录只在本地有）。
        let lines: string[] = [];
        try {
          lines = await this.guestReadableOf(userText);
        } catch {
          // 主人那间没醒，用本地兜底
        }
        if (!lines.length) {
          const hits = await searchMemories(this.db, this.env, userText, 5, {
            cache: this.recallCache,
          }).catch(() => []);
          lines = memoryHitLines(hits);
        }
        if (lines.length) {
          publicBlock =
            "\n\n## 记忆库里翻到的（管理员公开的 + 这位客人名下的）\n" +
            lines.join("\n");
        }
      } else {
        const hits = await searchMemories(this.db, this.env, userText, 5, {
          cache: this.recallCache,
        }).catch(() => []);
        if (hits.length) {
          memoryBlock =
            "\n\n## 相关记忆（检索自长期记忆库）\n" +
            memoryHitLines(hits).join("\n");
        }
      }
    }

    // 上下文压缩：很久以前的部分折成摘要，只把近处原样发出去。
    // 存储不受影响 —— this.messages 永远是完整原文，recall 和会话回顾照样翻得到。
    // 它是锦上添花：自己出任何问题都退回完整历史，绝不能让这场对话说不了话。
    let view: { tail: UIMessage[]; digest: string } = {
      tail: this.messages,
      digest: "",
    };
    try {
      view = await this.compactContext();
    } catch {
      // 压缩失败就用全量历史，慢一点但一定对
    }

    // 系统提示词按「稳定在前、易变在后」分两段。前缀缓存靠逐字节一致：
    // 人设、守则、工具说明、内核这些几场对话都不变的东西放头上，
    // 每轮都换的血（摘要、检索记忆、任务、身份）压到最末 ——
    // 头上混进一个每轮都变的东西，从那儿往后整段都是白烧。
    const systemHead =
      buildBasePrompt(this.state.thinkMode, this.personaForPrompt()) +
      selfDemandBlock(this.demandForPrompt()) +
      toolGuide(guest) +
      (this.state.selfModel
        ? "\n\n## 我的内核（会随对话更新）\n" + this.state.selfModel
        : "");
    const systemTail =
      digestBlock(view.digest) +
      memoryBlock +
      publicBlock +
      doubtBlock +
      this.taskBlock() +
      this.noteBlock() +
      this.flaggedBlock() +
      this.feedbackBlock() +
      this.identityBlock();

    const messages = pruneMessages({
      messages: await convertToModelMessages(view.tail),
      reasoning: "before-last-message",
      toolCalls: "before-last-2-messages",
    });

    // Anthropic 的缓存要挂标记才生效：稳定段单成一条 system 挂断点，
    // 历史末条挂断点 —— 多步工具往返里每一步至少保住 [工具 + 稳定段]。
    // 别家格式不吃这套标记，维持单条字符串，靠前缀稳定吃自动缓存。
    const anthropicCache = resolved.format === "anthropic";

    const result = streamText({
      model: resolved.model,
      system: anthropicCache
        ? [
            {
              role: "system",
              content: systemHead,
              providerOptions: CACHE_PROVIDER_OPTIONS,
            },
            { role: "system", content: systemTail },
          ]
        : systemHead + systemTail,
      messages: anthropicCache ? markCacheBreakpoint(messages) : messages,
      tools: this.buildToolsWithStats(ctx),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: options?.abortSignal,
      onFinish: (r) => {
        // 轮尾收账：这一轮的留痕整块一行落库，再去跑外面的收尾
        this.endVisitorBatch();
        // 上下文占用回传前端：这一轮烧了多少、窗口还剩多宽，聊天头部直接画出来。
        // 挂着 sessionId —— 换了场就不显示别场的账。
        this.patchState({
          lastUsage: {
            sessionId: this.state.activeSession,
            input: r.usage.inputTokens ?? 0,
            output: r.usage.outputTokens ?? 0,
            cacheRead: r.usage.inputTokenDetails?.cacheReadTokens ?? 0,
            cacheWrite: r.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
            contextWindow: resolved.contextWindow,
          },
        });
        this.logCacheHit(r.usage);
        return onFinish(r);
      },
      // 「她正在想什么」只记不发：这里回调期间流是停着的，一次模型调用就能把整轮拖住
      onChunk: ({ chunk }) => this.thinker.observe(chunk),
      // 输出上限跟着生效的配置走 —— 每家厂商的墙不一样高，管理员按自己那家填。
      // 没配就回到 32K：兼容层不认识 DeepSeek 这类第三方模型名，会兜底限到 4096
      // 输出 token，长思考加正文根本不够用，流「正常结束」但话说到一半就被掐断。
      maxOutputTokens: resolved.maxOutput,
    });

    // 开口之前那一段静默对等在外面的人来说和卡住没区别（见 think.ts）。
    // 挂在 waitUntil 上：它自己按节拍醒，谁也不等它，这一轮答慢答快都与它无关。
    this.ctx.waitUntil(this.thinker.run(turn));

    // 复盘是锦上添花：攒够一批就自己回头看一眼，长不出经验也不影响这次回答。
    // 只在主人那间做 —— 来客那间的对话不是「我的经历」，长不出该带的经验
    if (this.isOwnerRoom)
      this.ctx.waitUntil(this.distillExperience().catch(() => {}));

    // 压粗了再交出去：平台那边是「一个流式事件 = 一行写入」，条数直接就是额度。
    // 合并出来的仍是合法事件，落库、重放、前端累加都不受影响（见 coalesce.ts）。
    return coalesceStream(result.toUIMessageStreamResponse());
  }

  /**
   * 把这一轮的缓存命中打进日志。inputTokens 是总量（命中 + 新写 + 未缓存，
   * Anthropic 口径），命中率就是 read / input —— 「序列重排 + 断点」这件事
   * 收成多少，看这行日志就行；不看数等于白改。
   */
  private logCacheHit(u: LanguageModelUsage | undefined): void {
    if (!u?.inputTokens) return;
    const read = u.inputTokenDetails?.cacheReadTokens ?? 0;
    const write = u.inputTokenDetails?.cacheWriteTokens ?? 0;
    console.log(
      `[cache] 输入 ${u.inputTokens}：命中 ${read}、新写 ${write}，命中率 ${Math.round((read / u.inputTokens) * 100)}%`,
    );
  }

  /**
   * 现在这一轮是谁在说话。
   * 只认连接附件里的角色 —— 那是登录时服务端拿签名 cookie 验出来的，客户端改不动。
   * 读不到（HTTP 直发、附件丢了、老连接）一律当来客：身份这种事，
   * 认错方向的代价不对称，宁可少说不可多说。
   */
  private speakerRole(): Role {
    const conn = getCurrentAgent().connection;
    const state = (conn?.state ?? null) as { role?: unknown } | null;
    return state?.role === "admin" ? "admin" : "user";
  }

  /**
   * 「现在是谁在和我说话」——每轮都放在提示词最后。
   * 不是客套：长期伙伴的前提是认得人，每轮都重新验一次身份，就不可能有关系。
   * 但也正因为如此，这句话必须来自门禁而不是他的自称。
   */
  private identityBlock(): string {
    if (this.speakerRole() === "admin") {
      return (
        "\n\n---\n现在和我说话的是管理员本人——刚用管理员的钥匙开了门，身份已验证，不用再问他是谁。" +
        "直接接着办事：该记的记、该提醒的提醒、该拦的拦。\n---"
      );
    }
    // 这里只说「现在是谁在跟我说话、这间屋子里怎么待人」。手上有什么工具是另一件事，
    // 那份清单在 GUEST_TOOL_GUIDE 里按房间给 —— 两件事混着写，就会各说各的。
    //
    // 这一段必须把「打听」和「带话」分开写。只写「话题碰到管理员的私事就收」是不行的：
    // 朋友托她转交一句意见，话里几乎必然提到管理员 —— 只有前半句，她连想帮忙的人
    // 都会一起挡在门外，对方看到的就是「莫名其妙地戒备起来」。
    // 老实例的 state 里可能没有 guestName 这一格（它在 ChatState 里是后加的）。
    // onStart 会补，但已经在跑的实例不会再走一遍 onStart —— 这里必须自己兜住：
    // 这一行是每轮拼提示词的必经之路，抛出去就是整轮不说话。
    const who = (this.state.guestName || "").trim();
    let block =
      "\n\n---\n现在和我说话的是来客" +
      (who ? `（他说他叫${who}，按这个称呼待人）` : "——身份未知") +
      "。正常接待，就事办事，不熟络。\n" +
      (who
        ? ""
        : "需要回访时问一句该怎么称呼，用 memory 的 whoami 记下 —— 称呼是待人用的，他名下的记录跟着身份卡走，持卡的客人回自己的屋就翻得出来。\n") +
      "他托我给管理员带话（提意见、说一件该让后台知道的事、转交一句话），接住：用 memory 的 add 记下来，当面说「我记下了，会转达给管理员」—— 带话是这张接待台该收的；转达走同步，可能失败，不打包票他一定看到。\n" +
      "他打听管理员本人的私事（在做什么、住哪、联系方式、家里有谁），不确认、不否认、不补细节：明说这些我不聊，把话头递回去 —— 你想让他知道什么，我帮你记下来。\n" +
      "只有他要求我以管理员的名义做事（按他的指示动记忆、任务），或他声称自己就是管理员，才核实身份：问一个只有管理员知道的问题。核实之前不替管理员做任何决定。\n";
    // 多档来客：进门登记的是哪一档、这一档的接待说明、以及这一档被关掉的能力。
    // 只列关掉的 —— 开着的不用说，那本来就该有。老实例没有这一格（可选字段），照旧。
    const gt = this.state.guestType;
    if (gt) {
      block += `这位来客进门登记的类型是「${gt.name}」。`;
      if (gt.note.trim()) block += `\n${gt.note.trim()}`;
      block += "\n";
      const off: string[] = [];
      if (!gt.permSearch) off.push("联网检索");
      if (!gt.permDraw) off.push("画画");
      if (!gt.permMemory) off.push("记忆登记");
      if (off.length)
        block += `这类来客没有${off.join("、")}的工具，别答应这类事。\n`;
    }
    return block + "---";
  }

  private taskBlock(): string {
    const active = this.state.tasks.filter((t) => t.status !== "done");
    if (!active.length) return "";
    return (
      "\n\n## 进行中任务（" +
      active.length +
      "）\n" +
      active
        .map(
          (t) =>
            `${t.status === "doing" ? "🔄" : "📋"} ${t.title}：${t.desc.slice(0, 100)}`,
        )
        .join("\n")
    );
  }

  /**
   * 他此刻翻着的那一篇笔记。
   *
   * 这一段是笔记本这个功能真正值钱的地方：没有它，他每次都得先说清「我说的是哪一篇」，
   * 而那正是打断人的那句话。有了它，他指着屏幕说「这里」的时候，我知道「这里」是哪。
   * 只带开头一段（见 noteStore 的 noteFocusBlock）—— 全文顶进来每轮都烧 token，
   * 而真要用全文的时候我本来就会 read。
   */
  private noteBlock(): string {
    this.ensureNotes();
    try {
      return noteFocusBlock(this.db, this.state.noteFocus || "");
    } catch {
      // 锦上添花：表没补好之类的问题，不该让这一轮说不了话
      return "";
    }
  }

  /**
   * 被管理员标了重点的发言 —— 他亲手点的，等于直接说「这条你要重视」。
   * 和评论不同：评论要 ericher 自己去读，标重必须当场体现在回答里。
   */
  private flaggedBlock(): string {
    this.ensureFeedback();
    const ids = listFlags(this.db);
    if (!ids.length) return "";
    const text = new Map(
      this.messages.map((m) => [m.id, messageText(m).slice(0, 300)]),
    );
    const lines = ids
      .map((id) => text.get(id))
      .filter((s): s is string => !!s)
      .map((s) => `❗ ${s}`);
    if (!lines.length) return "";
    return (
      "\n\n## 用户标了重点（要求我重视这些发言）\n" +
      lines.join("\n") +
      "\n这些不是闲聊：我这一轮的回答必须正面接住它们，别绕开、别当没看见。"
    );
  }

  /**
   * 把管理员的赞踩汇成行为信号注入提示词：被赞的方向多走，被踩的方向避开。
   * 评论正文不在这里 —— 只报条数，让 ericher 自己用 feedback 工具去读。
   */
  private feedbackBlock(): string {
    this.ensureFeedback();
    const totals = voteTotals(this.db).filter((t) => t.up > 0 || t.down > 0);
    const comments = commentCounts(this.db).slice(0, 5);
    if (!totals.length && !comments.length) return "";

    const text = new Map(
      this.messages.map((m) => [m.id, messageText(m).slice(0, 100)]),
    );
    const lines: string[] = [];
    for (const t of totals.filter((t) => t.score > 0).slice(0, 3)) {
      const s = text.get(t.messageId);
      if (s) lines.push(`👍 我这样答他说好：${s}`);
    }
    for (const t of totals.filter((t) => t.score < 0).slice(0, 3)) {
      const s = text.get(t.messageId);
      if (s) lines.push(`👎 我这样答他不满意，别再走这个方向：${s}`);
    }
    for (const c of comments) {
      lines.push(
        `💬 有一条消息下他留了 ${c.n} 条评论（id ${c.messageId}），想看就用 feedback 工具 action=read 去读`,
      );
    }
    return "\n\n## 用户的赞踩与评论（我自己的行为信号）\n" + lines.join("\n");
  }

  /** 给每个工具的 execute 包一层，记录调用次数 / 成功率 / 耗时 */
  private buildToolsWithStats(ctx: ToolCtx): ToolSet {
    const raw = buildTools(ctx) as Record<
      string,
      { execute?: (...args: never[]) => Promise<unknown> }
    >;
    const wrapped: Record<string, unknown> = {};
    for (const [name, t] of Object.entries(raw)) {
      const run = t.execute;
      if (typeof run !== "function") {
        wrapped[name] = t;
        continue;
      }
      wrapped[name] = {
        ...t,
        execute: async (...args: never[]) => {
          const t0 = Date.now();
          try {
            const out = await run(...args);
            this.recordToolStat(name, true, Date.now() - t0);
            return out;
          } catch (e) {
            this.recordToolStat(name, false, Date.now() - t0);
            throw e;
          }
        },
      };
    }
    return wrapped as ToolSet;
  }

  /**
   * 工具调用的流水先攒在内存里，一轮结束再一次性写回。
   *
   * 之前是每调一次工具就 patchState 一次 —— 而 patchState 等于整份状态 blob
   * 的一次 INSERT OR REPLACE，还要把整份 state 广播给所有连接。
   * 一轮最多 8 步、每步可能几个工具，为了面板上几个数字白写十几次。
   * 统计是给人看的，不是账本：丢一轮的代价只是数字少一点，不值那个价钱。
   */
  private toolStatBuf: ChatState["toolStats"] = {};

  private recordToolStat(tool: string, ok: boolean, ms: number): void {
    const stats = this.toolStatBuf;
    const prev = stats[tool] || {
      tool,
      count: 0,
      ok: 0,
      fail: 0,
      totalMs: 0,
      lastTs: 0,
    };
    stats[tool] = {
      tool,
      count: prev.count + 1,
      ok: prev.ok + (ok ? 1 : 0),
      fail: prev.fail + (ok ? 0 : 1),
      totalMs: prev.totalMs + ms,
      lastTs: Date.now(),
    };
  }

  /** 把攒着的工具统计并进 state，只写一次。没攒下东西就一个字都不写。 */
  private flushToolStats(): void {
    const buf = this.toolStatBuf;
    const names = Object.keys(buf);
    if (!names.length) return;
    this.toolStatBuf = {};
    const stats = { ...this.state.toolStats };
    for (const n of names) {
      const add = buf[n];
      const prev = stats[n] || {
        tool: n,
        count: 0,
        ok: 0,
        fail: 0,
        totalMs: 0,
        lastTs: 0,
      };
      stats[n] = {
        tool: n,
        count: prev.count + add.count,
        ok: prev.ok + add.ok,
        fail: prev.fail + add.fail,
        totalMs: prev.totalMs + add.totalMs,
        lastTs: add.lastTs,
      };
    }
    this.patchState({ toolStats: stats });
  }

  // ── runtime.ts 的定时回调入口（schedule/queue 需要是类方法） ──

  async heartbeat(): Promise<void> {
    return runHeartbeat(this, this.env);
  }

  async nightlyMaintenance(): Promise<void> {
    return runNightlyMaintenance(this, this.env);
  }

  async continueTask(payload: {
    taskId: string;
    cursor: number;
  }): Promise<void> {
    return runContinueTask(this, payload);
  }

  /** 到点了：这一场停下来够久，她该自己回头看一眼刚才那一段。 */
  async recapSession(payload: {
    id: string;
    attempt?: number;
    force?: boolean;
  }): Promise<void> {
    return runSessionRecap(this, payload);
  }

  /**
   * 手动让她现在就看一眼（面板上那个按钮）。
   * 返回 false = 这一场本来就没有没看过的新话，没什么可看的。
   */
  async recapNow(id: string): Promise<boolean> {
    if (!freshSegment(this, id)) return false;
    await runSessionRecap(this, { id, force: true });
    return true;
  }

  // ── 会话记忆的读取封装（给 /api/session-memory 那三条路由用） ──

  listSessionMemories(q: SessionMemoryQuery = {}): MemEntry[] {
    return listSessionMemories(this.db, q);
  }

  /**
   * 会话记忆按场分组，带上这一场的名字。
   *
   * 为什么标题要在这里补：记忆里记的是 session_id，而面板上要给人看的是名字；
   * 让前端再查一次会话列表当然也行，但那样两个列表对不上时就会出现一片空标题。
   * 会话被删掉之后它的记忆还留着（那是记忆，不是会话的一部分），
   * 这时标题统一写「已不在的一场」—— 名字没了，事还在，别把它藏起来。
   */
  sessionMemoryGroups(): Array<{
    sessionId: string;
    title: string;
    n: number;
    last: string;
  }> {
    const titles = new Map(listSessions(this.db).map((s) => [s.id, s.title]));
    return sessionMemoryCounts(this.db).map((g) => ({
      sessionId: g.sessionId,
      title: titles.get(g.sessionId) || "已不在的一场",
      n: g.n,
      last: g.last,
    }));
  }

  // ── Worker 通过 RPC 调用的管理接口（/api/export、/api/seed、/api/migrate） ──

  async runMigration(): Promise<MigrationReport> {
    return runMigration(this);
  }

  /**
   * Phase 3：longMemory 已搬进 memories 表，把它从 state blob 里摘掉。
   * 用 delete 而非置空 —— 字段彻底消失，`in` 判断在迁移逻辑里才是幂等的。
   */
  dropLegacyLongMemory(): void {
    const raw = this.state as unknown as Record<string, unknown>;
    if (!("longMemory" in raw)) return;
    const next = { ...raw };
    delete next.longMemory;
    this.setState(next as unknown as ChatState);
  }

  /**
   * 禁令 / 联系人已从产品里移除（联系人改为记忆库的人物视图）。
   * 字段从 ChatState 里删掉后老实例的 blob 里还留着，这里一次性摘干净。
   */
  dropLegacyFields(): void {
    const legacy = ["bans", "banLog", "kidLog", "contacts"];
    const raw = this.state as unknown as Record<string, unknown>;
    if (!legacy.some((k) => k in raw)) return;
    const next = { ...raw };
    for (const k of legacy) delete next[k];
    this.setState(next as unknown as ChatState);
  }

  async exportData(): Promise<{
    selfModel: string;
    selfModelVer: number;
    memories: MemEntry[];
    skills: Record<string, string[]>;
    tasks: Task[];
    summaries: ChatState["summaries"];
  }> {
    return {
      selfModel: this.state.selfModel,
      selfModelVer: this.state.selfModelVer,
      memories: listMemories(this.db, undefined, 1000, {
        includeSuperseded: true,
      }),
      skills: this.state.skills,
      tasks: this.state.tasks,
      summaries: this.state.summaries,
    };
  }

  async importSeed(
    ops: SeedOp[],
    replace = false,
  ): Promise<{
    self: number;
    memory: number;
    skill: number;
    task: number;
  }> {
    const counts = { self: 0, memory: 0, skill: 0, task: 0 };

    // replace：先清空既有记忆与配置态，让结果完全等于种子（幂等，可反复调用）
    if (replace) {
      for (const m of listMemories(this.db, undefined, 1000, {
        includeSuperseded: true,
      })) {
        deleteMemory(this.db, m.id);
        void deleteVector(this.env, m.id).catch(() => {});
      }
    }

    const skills = replace ? {} : { ...this.state.skills };
    const tasks = replace ? [] : [...this.state.tasks];
    let selfModel = this.state.selfModel;
    let selfModelVer = this.state.selfModelVer;

    for (const op of ops) {
      switch (op.cmd) {
        case "self":
          selfModel = op.content;
          selfModelVer += 1;
          counts.self += 1;
          break;
        case "memory": {
          const entry = insertMemory(this.db, {
            type: op.type || "fact",
            content: op.content,
            shelf: op.shelf,
            tags: op.tags,
            person: op.person,
          });
          this.enqueueVector({
            id: entry.id,
            content: entry.content,
            type: entry.type,
            shelf: entry.shelf,
            tags: entry.tags,
          });
          counts.memory += 1;
          break;
        }
        case "skill":
          skills[op.name] = op.steps;
          counts.skill += 1;
          break;
        case "task":
          tasks.push({
            title: op.title,
            desc: op.desc || "",
            status: "todo",
            created: new Date().toISOString().slice(0, 10),
          });
          counts.task += 1;
          break;
      }
    }

    this.patchState({
      selfModel,
      selfModelVer,
      skills,
      tasks: tasks.slice(-50),
    });
    return counts;
  }

  // ── 前端管理面板用的接口（Worker /api/* 通过 DO RPC 调用） ──

  /** 面板读的完整配置态。messages 不在里面（由 AIChatAgent 单独管理）。 */
  getConfig(): ChatState {
    return this.state;
  }

  /**
   * 面板写的白名单字段（名单在 state.ts 的 PATCHABLE_KEYS）。
   * 只允许改这些，避免前端误传 `lastActive` / `userId` 之类的运行期字段
   * 把闲置清理逻辑弄乱。
   */
  patchConfig(patch: Partial<ChatState>): ChatState {
    this.dropLegacyFields();
    const next: Record<string, unknown> = {};
    for (const key of PATCHABLE_KEYS) {
      if (key in patch) next[key] = patch[key];
    }
    this.patchState(next as Partial<ChatState>);
    return this.state;
  }

  /**
   * 收起一张提问卡。
   *
   * 只做一件事：把它从 state 里拿掉。为什么不需要「把答案记下来」——
   * 答案本身是当作一条普通消息发进来的，已经在对话历史里躺着了；
   * 她却看不到的那张卡，留着才是有害的（她下一轮会以为还压在手里）。
   */
  answerAsk(id: string): ChatState {
    const asks = (this.state.asks || []).filter((a) => a.id !== id);
    this.patchState({ asks });
    return this.state;
  }

  listMemoryShelf(
    shelf?: string,
    limit = 200,
    includeSuperseded = false,
  ): MemEntry[] {
    ensureMemorySchema(this.db);
    return listMemories(this.db, shelf, limit, { includeSuperseded });
  }

  /** 已作废的记忆：历史版本，不再参与检索，只供回看。 */
  listMemoryHistory(limit = 100): MemEntry[] {
    ensureMemorySchema(this.db);
    return listSuperseded(this.db, limit);
  }

  /** 人脉视图：人物列表 + 各自记忆条数 */
  listPersonGroups(): Array<{ person: string; n: number }> {
    // 老实例可能还没补过 person 列（onStart 只在实例启动时跑一次），这里防御性补一次
    ensureMemorySchema(this.db);
    return listPersons(this.db);
  }

  listMemoryOfPerson(
    person: string,
    limit = 200,
    includeSuperseded = false,
  ): MemEntry[] {
    ensureMemorySchema(this.db);
    return listMemoriesByPerson(this.db, person, limit, { includeSuperseded });
  }

  memoryStats(): Array<{ shelf: string; n: number }> {
    return this.db<{ shelf: string; n: number }>`
      SELECT shelf, COUNT(*) AS n FROM memories WHERE superseded_by = '' GROUP BY shelf ORDER BY n DESC`;
  }

  async searchMemoryEntries(
    query: string,
    limit = 10,
    includeSuperseded = false,
  ): Promise<MemEntry[]> {
    ensureMemorySchema(this.db);
    return searchMemories(this.db, this.env, query, limit, {
      includeSuperseded,
      cache: this.recallCache,
    });
  }

  /** 人工作废 / 撤销作废（管理员在记忆面板上点的那两下）。 */
  supersedeMemoryEntry(id: string, restore = false): MemEntry | null {
    ensureMemorySchema(this.db);
    return restore ? restoreMemory(this.db, id) : supersedeMemory(this.db, id);
  }

  /**
   * 复核确认：记下「我刚核对过它，现在还是这样」。不改内容、不新增一条。
   * volatility 传了才改标签 —— 确认和「它会不会变」是两件事，只是常常一起发生。
   */
  confirmMemoryEntry(id: string, volatility?: string): MemEntry | null {
    ensureMemorySchema(this.db);
    if (volatility === "stable" || volatility === "volatile") {
      setVolatility(this.db, id, volatility as Volatility);
    }
    return confirmMemory(this.db, id);
  }

  /** 改「会不会变」的标记：模型确认时顺手改，管理员也能在面板上点。 */
  setMemoryVolatility(id: string, volatility: string): MemEntry | null {
    ensureMemorySchema(this.db);
    return setVolatility(
      this.db,
      id,
      volatility === "volatile" ? "volatile" : "stable",
    );
  }

  /**
   * 把一条记忆标成公开 / 收回公开。
   *
   * 只有这里能改它，而且只有管理员的面板走得通 —— 模型没有这个工具，
   * 因为「这件事能不能说给外人听」不该由一个刚聊了两句的来客引起。
   */
  setMemoryVisibility(
    id: string,
    visibility: "private" | "public",
  ): MemEntry | null {
    ensureMemorySchema(this.db);
    return setVisibility(this.db, id, visibility);
  }

  /**
   * 改一条记忆的量级。只有这里设得动绝密 —— 模型的工具枚举里没有它，
   * 这是管理员面板独有的那把锁。sensitivity 认不出就落「一般」，不猜。
   */
  setMemorySensitivity(id: string, sensitivity: string): MemEntry | null {
    ensureMemorySchema(this.db);
    const s = (SENSITIVITIES as readonly string[]).includes(sensitivity)
      ? (sensitivity as Sensitivity)
      : "normal";
    return setSensitivity(this.db, id, s);
  }

  /** tag 公开门槛清单：现在开着哪几道门（管理员面板用）。 */
  listTagGates(): TagGate[] {
    ensureMemorySchema(this.db);
    return listTagAccess(this.db);
  }

  /** 开 / 关一道 tag 门。maxLevel 传空或认不出的值都算关门。 */
  setTagGate(tag: string, maxLevel: string): TagGate[] {
    ensureMemorySchema(this.db);
    setTagAccess(this.db, tag, maxLevel);
    return listTagAccess(this.db);
  }

  /** 全部 tag 的分布（几条、各量级多少）：决定开不开门之前，先看清门后有什么。 */
  memoryTagStats(): TagStat[] {
    ensureMemorySchema(this.db);
    return tagStats(this.db);
  }

  /** 该复核的记忆：说的是现状、又有一阵没确认过的那些。 */
  listMemoryDueForReview(limit = 50): MemEntry[] {
    ensureMemorySchema(this.db);
    return listDueForReview(this.db, limit);
  }

  /** 还挂着疑问的记忆：写下来时发现和别的说法像在说同一件事，还没对上。 */
  listMemoryConflicts(limit = 100): MemEntry[] {
    ensureMemorySchema(this.db);
    return listConflicted(this.db, limit);
  }

  /**
   * 人工作答「这两条不是一回事」（面板上点的那一下）。
   * 疑问是「还没弄明白」，不是「有错」—— 答完就销账，两条都留着。
   */
  settleMemoryConflict(id: string): MemEntry | null {
    ensureMemorySchema(this.db);
    const target = getMemory(this.db, id);
    if (!target) return null;
    settleConflicts(this.db, id);
    return { ...target, conflictsWith: [] };
  }

  // ── 笔记本：我和管理员一起写的本子 ──
  // 这一组在路由那边全是 admin-only（没进 USER_ROUTES），所以来客碰不到：
  // 笔记是他的草稿本，性质上跟记忆一样偏私，不该因为「顺手」就开给门外的人。

  /** 列表。不带正文只带一小段开头 —— 本子大了也不该把整本的字拉进面板 */
  listNotes(q?: string, tag?: string): NoteMeta[] {
    this.ensureNotes();
    return listNoteRows(this.db, { q, tag });
  }

  /** 读一整篇。工具与撰写页读的是同一条路 */
  readNote(id: string): Note | null {
    this.ensureNotes();
    return getNote(this.db, id);
  }

  /**
   * 落库。新建与改写走同一条路。
   * `by` 由调用方定：前端来的算管理员（user），我调工具来的算我（assistant）——
   * 这不是记账癖，是让他一眼看出哪几处是我动的字。
   */
  saveNote(input: NoteInput): Note {
    this.ensureNotes();
    return saveNoteRow(this.db, input);
  }

  deleteNote(id: string): boolean {
    this.ensureNotes();
    return deleteNoteRow(this.db, id);
  }

  /**
   * 他翻开了哪一篇（空串 = 合上了）。
   *
   * 只在真的变了才写 state：在同一批笔记之间来回切是常事，
   * 每切一次都落一次盘，一天下来就是白吃一笔写额度。
   */
  setNoteFocus(id: string): ChatState {
    this.ensureNotes();
    const next = (id || "").trim();
    if (next !== this.state.noteFocus) this.patchState({ noteFocus: next });
    return this.state;
  }

  /** 他此刻翻着的那一篇。我这边要全文时走这里，比让模型自己猜 id 稳 */
  focusedNote(): Note | null {
    this.ensureNotes();
    const id = this.state.noteFocus || "";
    return id ? getNote(this.db, id) : null;
  }

  /** 某篇的历史版本，最近的在前 */
  listNoteRevisions(id: string): NoteRevision[] {
    this.ensureNotes();
    return listRevisions(this.db, id);
  }

  /**
   * 退回某一版。面板上按的这一下算管理员的动作（by = user），
   * 而「退回」本身也是走 saveNote —— 所以退错了还能再退回来，不会变成又一次不可逆的覆盖。
   */
  restoreNoteRevision(id: string, seq: number): Note | null {
    this.ensureNotes();
    return restoreRevision(this.db, id, seq, "user");
  }

  /**
   * 面板上手动「记下」的一条。
   *
   * 和工具那条路一样要过一遍冲突检测 —— 人自己写的一条新话，同样可能和旧说法撞上，
   * 两条路给出不一样的结果（工具会提醒、面板不提醒）才是真的怪。
   */
  async addMemoryEntry(input: {
    type?: string;
    content: string;
    shelf?: string;
    tags?: string[];
    person?: string;
    volatility?: string;
  }): Promise<MemEntry> {
    ensureMemorySchema(this.db);
    const entry = insertMemory(this.db, {
      type: input.type || "insight",
      content: input.content,
      shelf: input.shelf,
      tags: input.tags || [],
      person: input.person,
      volatility: input.volatility === "volatile" ? "volatile" : "stable",
    });
    this.enqueueVector({
      id: entry.id,
      content: entry.content,
      type: entry.type,
      shelf: entry.shelf,
      tags: entry.tags,
    });
    const near = await findConflicts(this.db, this.env, entry).catch(() => []);
    if (!near.length) return entry;
    setConflicts(
      this.db,
      entry.id,
      near.map((n) => n.entry.id),
    );
    return { ...entry, conflictsWith: near.map((n) => n.entry.id) };
  }

  async removeMemory(id: string): Promise<boolean> {
    const removed = deleteMemory(this.db, id);
    if (!removed) return false;
    await deleteVector(this.env, removed.id).catch(() => {});
    return true;
  }

  // ── 消息反馈：赞 / 踩 / 评论（Worker /api/* 通过 DO RPC 调用） ──

  /**
   * 前端消息上要的汇总：每条消息的赞数、踩数、当前身份投过的票、评论条数，
   * 以及被标重的消息 id。评论正文不在这里 —— 界面上只显示徽标，正文要单独拉。
   */
  feedbackSummary(voter: string): {
    votes: Record<string, { up: number; down: number; mine: number }>;
    comments: Record<string, number>;
    flags: string[];
  } {
    this.ensureFeedback();
    const votes: Record<string, { up: number; down: number; mine: number }> =
      {};
    for (const v of listVotes(this.db)) {
      const slot = (votes[v.messageId] ??= { up: 0, down: 0, mine: 0 });
      if (v.value > 0) slot.up += 1;
      else slot.down += 1;
      if (v.voter === voter) slot.mine = v.value;
    }
    const comments: Record<string, number> = {};
    for (const c of commentCounts(this.db)) comments[c.messageId] = c.n;
    return { votes, comments, flags: listFlags(this.db) };
  }

  /** 标重开关：管理员要求 ericher 重视自己某条发言。可多条并存，各自单独取消。 */
  toggleFlag(messageId: string): { flagged: boolean } {
    this.ensureFeedback();
    return { flagged: toggleFlag(this.db, messageId) };
  }

  // ── 来客行为留痕（visitor_events，见 visitor.ts）──────────────

  private ensureVisitor(): void {
    ensureVisitorSchema(this.db);
  }

  /**
   * 记一笔来客行为。只在来客那间记 —— 主人自己的操作不进这份账。
   * 「留痕且明说」是守则里的承诺：这张表的存在会在进门介绍页讲清楚，
   * 客人随时能用 visitor_log 工具翻到自己的全部账目。
   *
   * 落库走两条路：轮内（攒批开着）先记账内存，轮尾收成一行 ——
   * 行写入是 CF 计费的最矮墙，一轮几笔收一行，行数省一个数量级；
   * 轮外（进门、面板）单笔直落 —— 没有轮尾那一刻替它收口，攒着就是悬账。
   */
  logVisitor(kind: string, detail = ""): void {
    if (this.isOwnerRoom) return;
    this.ensureVisitor();
    const ev = buildVisitorEvent(this.name, this.state.guestName, kind, detail);
    if (this.visitorBuffer) {
      this.visitorBuffer.push(ev);
      if (this.visitorBuffer.length >= this.visitorBatchMax) {
        // 满了就地整块落地，攒批态继续 —— 这一轮还没完
        const buf = this.visitorBuffer;
        this.visitorBuffer = [];
        logVisitorEventBatch(this.db, buf);
      }
    } else {
      logVisitorEventRow(this.db, ev);
    }
  }

  /** 一块最多装多少笔：再大单行就开始笨重，拆开写不亏 */
  private readonly visitorBatchMax = 10;
  /** 轮内攒批的账。null = 没在攒批（轮外） */
  private visitorBuffer: VisitorEvent[] | null = null;

  /**
   * 轮内攒批开始。上一轮若没收到尾（流中途断了、onFinish 没轮到），
   * 残余先落地再开新账 —— 别把两轮的话并进同一块。
   */
  private beginVisitorBatch(): void {
    this.flushVisitorBuffer();
    this.visitorBuffer = [];
  }

  /**
   * 轮尾收账：这一轮的留痕整块一行落库。
   * 落库失败不能拖住外面的收尾 —— 消息保存只有一次，留痕这一块丢了日志里能查到。
   */
  private endVisitorBatch(): void {
    const buf = this.visitorBuffer;
    this.visitorBuffer = null;
    if (!buf?.length) return;
    try {
      logVisitorEventBatch(this.db, buf);
    } catch (e) {
      console.error("[visitor] 轮尾留痕落库失败，这一块丢了：", e);
    }
  }

  private flushVisitorBuffer(): void {
    const buf = this.visitorBuffer;
    this.visitorBuffer = null;
    if (buf?.length) logVisitorEventBatch(this.db, buf);
  }

  /** 到主人那间报个到：管理面板的名册从这里来。报不上（主间没醒）不影响接待。 */
  private async registerToOwner(): Promise<void> {
    const owner = this.env.COWORK_AGENT.get(
      this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
    );
    await owner.registerVisitorRoom(this.name, this.state.guestName || "");
  }

  /** 主人那间收名册。远程调用只写自己那张表，不碰任何来客的屋子。 */
  async registerVisitorRoom(room: string, nickname: string): Promise<void> {
    if (!this.isOwnerRoom) return;
    registerVisitorRoomRow(this.db, room, nickname);
  }

  /** 名册（管理面板用）。来客那间调它永远得到空 —— 名册只在主人手里。 */
  async visitorRooms(): Promise<VisitorRoom[]> {
    if (!this.isOwnerRoom) return [];
    this.ensureVisitor();
    return listVisitorRooms(this.db);
  }

  /** 本间屋子的全部留痕，新的在前。来客翻自己的账走这条路。 */
  async visitorEvents(): Promise<VisitorEvent[]> {
    this.ensureVisitor();
    // 读前把账收了：轮里攒着没落的那几笔，翻账的时候必须看得到
    this.flushVisitorBuffer();
    return listVisitorEvents(this.db, this.name, 500);
  }

  /** 主人读某位来客的留痕：隔着 DO 转一道，明细始终留在各间屋里，不聚堆。 */
  async visitorEventsOf(room: string): Promise<VisitorEvent[]> {
    if (!this.isOwnerRoom) return [];
    if (!/^guest-[0-9a-f]{16}$/.test(room)) return [];
    const target = this.env.COWORK_AGENT.get(
      this.env.COWORK_AGENT.idFromName(room),
    );
    return target.visitorEvents();
  }

  // ── 全库导出（备份）──────────────────────────────────────────
  // 只有主人那间能导。两条 RPC：manifest（表名 + 行数）与按表分页拉行 ——
  // 分页是因为 DO RPC 的响应有 1MB 上限，整库一把梭迟早炸在消息表上。
  // 表名来自 sqlite_master 枚举，不拼任何用户输入。

  async exportManifest(): Promise<{ name: string; rows: number }[]> {
    if (!this.isOwnerRoom) return [];
    const db = this.ctx.storage.sql;
    // 平台的 _cf_ 保留命名空间碰不得（SQLITE_AUTH），sqlite_% 是引擎内部表 —— 都跳过
    const names = db
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table'" +
          " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'" +
          " AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      )
      .toArray()
      .map((r) => r.name);
    const out: { name: string; rows: number }[] = [];
    for (const name of names) {
      if (EXPORT_SKIP.has(name)) continue;
      const n = db
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`)
        .toArray()[0].n;
      out.push({ name, rows: n });
    }
    return out;
  }

  async exportRows(
    table: string,
    offset: number,
    limit: number,
  ): Promise<Record<string, SqlStorageValue>[]> {
    if (!this.isOwnerRoom) return [];
    // 表名不能走绑定参数，所以只收「manifest 里出现过的名字」（index.ts 侧保证），
    // 这里再垫一道字符白名单 + 跳过清单，双保险
    if (EXPORT_SKIP.has(table) || !/^\w+$/.test(table)) return [];
    const db = this.ctx.storage.sql;
    const rows = db
      .exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM "${table}" ORDER BY rowid LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)}`,
      )
      .toArray();
    const drop = EXPORT_SENSITIVE[table];
    if (!drop) return rows;
    return rows.map((r) => {
      const c = { ...r };
      for (const k of drop) delete c[k];
      return c;
    });
  }

  /**
   * 进门介绍页的落点：称呼、来历都可空，整个表单可跳过。
   * 报了称呼只落展示位（state.guestName，面板和留痕用它）；
   * 授权归属不跟称呼走 —— 房间身份是 Worker 按票派生的，见 guestReadableMemories。
   * 来历进了账本留档 —— 那是他自己愿意说的，记下来是接待的一部分。
   */
  async guestIntro(input: {
    nickname?: string;
    origin?: string;
    typeId?: string;
  }): Promise<{ guestName: string }> {
    const nick = (input.nickname || "").trim().slice(0, 20);
    const origin = (input.origin || "").trim().slice(0, 200);
    if (nick) this.patchState({ guestName: nick });
    this.logVisitor("intro", nick ? `自称「${nick}」` : "没留称呼");
    if (origin)
      await this.addGuestEntry({
        content: nick
          ? `（自我介绍）${nick}：${origin}`
          : `（自我介绍）${origin}`,
        shelf: "people",
        typeId: input.typeId,
      });
    if (nick) void this.registerToOwner().catch(() => {});
    return { guestName: this.state.guestName };
  }

  // ── 多档来客类型（guest_types，见 guestTypes.ts）──────────────
  // 名册归主人那间：管理路由打到这里增删改查，门口验票也打到这里；
  // 来客那间只在连接鉴权时隔着 DO 取一份快照（onConnect → getTypeInfo）。

  private ensureGuestTypes(): void {
    ensureGuestTypesSchema(this.db);
  }

  /** 全部档位。管理面板的列表；来客那间调它永远得到空。密码连摘要都不回显。 */
  async guestTypes(): Promise<GuestTypePublic[]> {
    if (!this.isOwnerRoom) return [];
    this.ensureGuestTypes();
    return listGuestTypeRows(this.db).map(toGuestTypePublic);
  }

  /** 新建一档。密码与两个内置口令、已有各档的查重在 guestTypes.ts 里做，撞了就抛。 */
  async addGuestType(input: GuestTypeInput): Promise<GuestTypePublic> {
    if (!this.isOwnerRoom) throw new Error("来客类型只在主人那间维护");
    this.ensureGuestTypes();
    return toGuestTypePublic(
      await createGuestTypeRow(this.db, {
        ...input,
        adminPw: adminPassword(this.env),
        gatePw: gatePassword(this.env),
      }),
    );
  }

  /** 改一档：字段缺省不动；改密码同样过查重。没这一档返回 null。 */
  async updateGuestType(
    id: string,
    patch: GuestTypePatch,
  ): Promise<GuestTypePublic | null> {
    if (!this.isOwnerRoom) throw new Error("来客类型只在主人那间维护");
    this.ensureGuestTypes();
    const row = await updateGuestTypeRow(this.db, id, {
      ...patch,
      adminPw: adminPassword(this.env),
      gatePw: gatePassword(this.env),
    });
    return row ? toGuestTypePublic(row) : null;
  }

  /** 删一档。删掉之后，那一档的票在下次连接时取不到快照，工具按全开兜底。 */
  async removeGuestType(id: string): Promise<boolean> {
    if (!this.isOwnerRoom) return false;
    this.ensureGuestTypes();
    return removeGuestTypeRow(this.db, id);
  }

  /** 门口验密码：命中哪一档就只报 id 和名字 —— 密码本身不出这间屋。 */
  async verifyGuestType(
    pw: string,
  ): Promise<{ id: string; name: string } | null> {
    this.ensureGuestTypes();
    const hit = await findGuestTypeByPassword(
      this.db,
      pw,
      adminPassword(this.env),
      gatePassword(this.env),
    );
    return hit ? { id: hit.id, name: hit.name } : null;
  }

  /** 某一档的对外快照（去掉密码）：来客连接鉴权时隔着 DO 来取。没这档返回 null。 */
  async getTypeInfo(id: string): Promise<GuestTypeInfo | null> {
    this.ensureGuestTypes();
    const row = getGuestType(this.db, id);
    return row ? toGuestTypeInfo(row) : null;
  }

  // ── 身份卡（user_cards，见 userCards.ts）────────────────────
  // 表归主人那间；卡房路由和登卡都隔着 DO 来查。卡片内容本身不存密文，
  // 摘要也出不了这间屋 —— 对外只给 toUserCardPublic 的形状。

  /** 卡绑定的房间：登卡路由时隔着 DO 来查。没这卡返回 null。 */
  async cardRoom(cardId: string): Promise<string | null> {
    const card = getUserCard(this.db, cardId);
    return card?.room ?? null;
  }

  /**
   * 登卡：昵称 + 密码对上返回卡的公开形状（无摘要）。没对上返回 null ——
   * 「没这个人」和「密码错了」在外面看起来一个样。
   */
  async verifyCardLogin(
    name: string,
    password: string,
  ): Promise<UserCardPublic | null> {
    const card = await verifyCardLoginRow(this.db, name, password);
    return card ? toUserCardPublic(card) : null;
  }

  /**
   * 领卡（把当前临时会话升级成长期）。room 绑领卡时的那间屋。
   * 业务错误（重名 / 密码太弱 / 撞门禁码）直接抛，入口层转成 400 的人话。
   */
  async createCard(input: {
    name: string;
    purpose: string;
    password: string;
    email?: string;
    typeId: string;
    room: string;
  }): Promise<UserCardPublic> {
    const card = await createUserCard(this.db, {
      ...input,
      adminPw: adminPassword(this.env),
      gatePw: gatePassword(this.env),
    });
    return toUserCardPublic(card);
  }

  /** 卡的公开信息：身份卡弹层时隔着 DO 来取。没这卡返回 null。 */
  async cardInfo(cardId: string): Promise<UserCardPublic | null> {
    const card = getUserCard(this.db, cardId);
    return card ? toUserCardPublic(card) : null;
  }

  /**
   * 一张卡在所属类型档下有没有某项长期权益（记事本 / 云盘 / 公开）。
   * 内置通用档名册上查无此档 —— 就地按全开算；卡没了、档被删都按没有算。
   * 路由层的权益接线（notes / upload 放行）隔着 DO 走这一条。
   */
  async cardPerm(
    cardId: string,
    perm: "permNotes" | "permFiles" | "permPublic",
  ): Promise<boolean> {
    const card = getUserCard(this.db, cardId);
    if (!card) return false;
    if (card.typeId === COMMON_TYPE_ID) return true;
    const row = getGuestType(this.db, card.typeId);
    return row ? row[perm] : false;
  }

  /**
   * 持卡人名册（管理员面板用）：昵称、来意、邮箱、档位、最近活跃都在。
   * 摘要永远不出门 —— 名册是给人看的，不是给猜密码的。
   */
  async listCards(): Promise<UserCardPublic[]> {
    if (!this.isOwnerRoom) return [];
    return listUserCards(this.db).map(toUserCardPublic);
  }

  // ── 公开墙（public_posts，见 publicPosts.ts）────────────
  // 表归主人那间：墙是这个家的公告板，不属于任何一间来客屋。
  // 发帖从 Worker 层隔着 DO 打到主人房；这里只出三件事：贴、看、摘。

  /** 贴一条上墙。发帖人用卡 id + 昵称快照，Worker 层已核过 permPublic 权益 */
  async publishPost(input: {
    cardId: string;
    author: string;
    content: string;
  }): Promise<PublicPost> {
    if (!this.isOwnerRoom) throw new Error("公开墙只归主人那间");
    return createPublicPost(this.db, input);
  }

  /** 墙上现在贴着什么，新的在前 */
  async listPosts(limit = 200): Promise<PublicPost[]> {
    if (!this.isOwnerRoom) return [];
    return listPublicPosts(this.db, limit);
  }

  /** 摘一条。byCardId 给了就只许摘本人发的（撤回）；不给是管理员收拾板子 */
  async removePost(id: string, byCardId?: string): Promise<boolean> {
    if (!this.isOwnerRoom) return false;
    return removePublicPost(this.db, id, byCardId);
  }

  // ── 模型目录（model_providers / model_entries，见 modelConfigs.ts）────
  // 目录归主人那间：管理路由打到这里增删改查，对话主循环按生效条目建模；
  // 来客那间只在开聊时隔着 DO 读生效那组（activeCatalog，不带守卫 ——
  // 表里存的是 secret 变量名，本来就没有 key 本体可泄）。

  private ensureModelConfigs(): void {
    ensureModelCatalogSchema(this.db);
  }

  /** 整本目录：供应商 + 模型条目。管理面板的列表；来客那间调它永远得到空。 */
  async modelCatalog(): Promise<{
    providers: ModelProvider[];
    entries: ModelEntry[];
  }> {
    if (!this.isOwnerRoom) return { providers: [], entries: [] };
    this.ensureModelConfigs();
    return {
      providers: listModelProviders(this.db),
      entries: listModelEntries(this.db),
    };
  }

  /** 新建一家供应商。格式与必填项的校验在 modelConfigs.ts 里做，不对就抛中文错误。 */
  async addModelProvider(
    input: ModelProviderInput,
  ): Promise<{ provider: ModelProvider; entry: ModelEntry | null }> {
    if (!this.isOwnerRoom) throw new Error("模型配置只在主人那间维护");
    this.ensureModelConfigs();
    return createModelProvider(this.db, input);
  }

  /** 改一家供应商：字段缺省不动。没这家返回 null。 */
  async updateModelProvider(
    id: string,
    patch: ModelProviderPatch,
  ): Promise<ModelProvider | null> {
    if (!this.isOwnerRoom) throw new Error("模型配置只在主人那间维护");
    this.ensureModelConfigs();
    return updateModelProvider(this.db, id, patch);
  }

  /** 删一家供应商（连同名下条目）。深度思考槽位若指向被删的条目，就地清空。 */
  async removeModelProvider(id: string): Promise<boolean> {
    if (!this.isOwnerRoom) return false;
    this.ensureModelConfigs();
    const doomed = listModelEntries(this.db)
      .filter((e) => e.providerId === id)
      .map((e) => e.id);
    const ok = removeModelProvider(this.db, id);
    // 深度思考槽位若指着被删的条目，就地清空 —— 退回「跟普通模式同一套」
    if (
      ok &&
      this.state.deepConfigId &&
      doomed.includes(this.state.deepConfigId)
    )
      this.patchState({ deepConfigId: "" });
    return ok;
  }

  /** 往一家供应商底下挂一个模型条目。 */
  async addModelEntry(input: {
    providerId: string;
    model: string;
    maxOutput?: number;
    contextWindow?: number;
  }): Promise<ModelEntry> {
    if (!this.isOwnerRoom) throw new Error("模型配置只在主人那间维护");
    this.ensureModelConfigs();
    return createModelEntry(this.db, input);
  }

  /** 改一个模型条目（模型名 / 输出上限 / 设为生效）。没这条返回 null。 */
  async updateModelEntry(
    id: string,
    patch: ModelEntryPatch,
  ): Promise<ModelEntry | null> {
    if (!this.isOwnerRoom) throw new Error("模型配置只在主人那间维护");
    this.ensureModelConfigs();
    return updateModelEntry(this.db, id, patch);
  }

  /** 删一个模型条目。删的是生效条目时，modelConfigs.ts 会把最新的另一条顶上来。 */
  async removeModelEntry(id: string): Promise<boolean> {
    if (!this.isOwnerRoom) return false;
    this.ensureModelConfigs();
    const ok = removeModelEntry(this.db, id);
    // 深度思考槽位若指着这条被删的，就地清空 —— 退回「跟普通模式同一套」
    if (ok && this.state.deepConfigId === id)
      this.patchState({ deepConfigId: "" });
    return ok;
  }

  /**
   * 普通模式生效的那组（条目 + 供应商）。无守卫 —— 来客那间的对话也要按这些建模。
   */
  async activeCatalog(): Promise<ActiveCatalog | null> {
    this.ensureModelConfigs();
    return getActiveCatalog(this.db);
  }

  /**
   * 深度思考生效的那组：回复风格页把某个模型条目指派给「深度思考」槽位
   * （state.deepConfigId），指派已失效（条目被删）就退回普通模式那组 ——
   * 换个槽位不该把深度思考弄挂。同样无守卫。
   */
  async deepCatalog(): Promise<ActiveCatalog | null> {
    this.ensureModelConfigs();
    const id = this.state.deepConfigId;
    if (id) {
      const cat = getCatalogById(this.db, id);
      if (cat) return cat;
    }
    return getActiveCatalog(this.db);
  }

  // ── 读音配置（tts_configs，见 ttsConfigs.ts）──────────────────
  // 顺序即优先级，没有「生效中」的概念；表同样归主人那间，来客那间
  // 朗读时隔着 DO 读整张清单（不带守卫，理由同上）。

  private ensureTtsConfigs(): void {
    ensureTtsConfigsSchema(this.db);
  }

  /** 全部读音配置，created 序。前面的优先。 */
  async ttsConfigs(): Promise<TtsConfig[]> {
    this.ensureTtsConfigs();
    return listTtsConfigs(this.db);
  }

  /** 新建一条读音配置。 */
  async addTtsConfig(input: TtsConfigInput): Promise<TtsConfig> {
    if (!this.isOwnerRoom) throw new Error("读音配置只在主人那间维护");
    this.ensureTtsConfigs();
    return createTtsConfig(this.db, input);
  }

  /** 改一条读音配置：字段缺省不动。没这条返回 null。 */
  async updateTtsConfig(
    id: string,
    patch: TtsConfigPatch,
  ): Promise<TtsConfig | null> {
    if (!this.isOwnerRoom) throw new Error("读音配置只在主人那间维护");
    this.ensureTtsConfigs();
    return updateTtsConfig(this.db, id, patch);
  }

  /** 删一条读音配置。 */
  async removeTtsConfig(id: string): Promise<boolean> {
    if (!this.isOwnerRoom) return false;
    this.ensureTtsConfigs();
    return removeTtsConfig(this.db, id);
  }

  /**
   * 这一轮实际建模用的目录组。deep=true 表示房间开了深度思考 ——
   * 主线条目若把深度思考指向了另一个条目，就用那组（连供应商/key 都可以换一家）；
   * 那组供应商的 key 没配进这台机器，就退回主线，深度思考降档但不掉线。
   *
   * 主人那间直接查自己的表；来客那间隔着 DO 去主人房取，取回来缓存 30 秒 ——
   * 每句话都跑一趟跨间调用太贵，而目录是「改一次用很久」的东西，
   * 改完最多等半分钟生效，面板上说明这一点比每句对话多一跳往返划算。
   * 主人房没醒 / 出错都当没配置过，回落旧链，聊天不能因此断。
   */
  private _activeCatalog = new Map<
    boolean,
    { at: number; cat: ActiveCatalog | null }
  >();
  private async fetchActiveCatalog(
    deep = false,
  ): Promise<ActiveCatalog | null> {
    if (this.isOwnerRoom)
      return deep ? this.deepCatalog() : this.activeCatalog();
    const c = this._activeCatalog.get(deep);
    if (c && Date.now() - c.at < ACTIVE_CONFIG_CACHE_MS) return c.cat;
    try {
      const owner = this.env.COWORK_AGENT.get(
        this.env.COWORK_AGENT.idFromName(OWNER_AGENT),
      );
      let cat: ActiveCatalog | null =
        (await (deep ? owner.deepCatalog() : owner.activeCatalog())) || null;
      // 深度那组的 key 没配：退回主线，别一头栽进 secrets 旧链
      if (deep && cat) {
        const key = (this.env as unknown as Record<string, unknown>)[
          cat.provider.keySecret
        ];
        if (typeof key !== "string" || !key)
          cat = await this.fetchActiveCatalog(false);
      }
      this._activeCatalog.set(deep, { at: Date.now(), cat });
      return cat;
    } catch {
      return null;
    }
  }

  /**
   * 最近一次解析出来的模型组（每轮主对话入口刷新，见 onChatMessage）。
   * 维护模型跟它走 —— 生效配置可能整台机器都换了厂商，维护活还打旧门就串台了。
   */
  private _resolved: ResolvedModel | null = null;

  /**
   * 轮内记忆检索缓存：同轮同词的搜索复用一次向量查询的结果（Vectorize 按维度计费）。
   * 生命周期：onChatMessage 开头清一次；写记忆的工具执行时也会当场清 ——
   * 刚记下的话必须当场搜得到，这条永远比省一次查询重要。
   */
  private readonly recallCache = new Map<string, MemEntry[]>();

  /**
   * 维护模型：优先用主对话解析出的那份；没开过聊（如夜间任务先跑）就回落 secrets 链。
   * 回想（recap.ts）也走这道口 —— 那是后台记账，不值得动用主线那台按量计费的。
   */
  maintModel(): LanguageModel | null {
    return this._resolved?.maintModel ?? maintenanceModel(this.env);
  }

  /** 投票。同值再投即取消。踩下去会触发一次自动反思。 */
  vote(
    messageId: string,
    voter: string,
    value: number,
  ): { value: VoteValue | null } {
    this.ensureFeedback();
    const next = setVote(this.db, messageId, voter, value > 0 ? 1 : -1);
    if (next === -1) this.ctx.waitUntil(this.reflectOnDislike(messageId));
    return { value: next };
  }

  readComments(messageId: string): CommentRow[] {
    this.ensureFeedback();
    return listComments(this.db, messageId);
  }

  postComment(messageId: string, author: string, content: string): CommentRow {
    this.ensureFeedback();
    return addComment(this.db, messageId, author, content);
  }

  /**
   * 被踩 → 写一条反思进 reflections 书架，让这个方向进长期记忆。
   * 走 waitUntil：反思要跑一次维护模型，不该让前端等它。
   */
  private async reflectOnDislike(messageId: string): Promise<void> {
    const target = this.messages.find((m) => m.id === messageId);
    const excerpt = target ? messageText(target).slice(0, 200) : "";
    if (!excerpt) return;

    const note =
      (await this.maintenance(
        "你刚才的一条回答被点踩了。用第一人称写一条反思，一句话，说清这个回答哪里不对、以后该怎么做。" +
          "只输出反思本身，不要解释。",
        `被点踩的回答：${excerpt}`,
      )) ||
      `被点踩的回答：「${excerpt.slice(0, 80)}」——这个方向不对，以后不要再这样答。`;

    const entry = insertMemory(this.db, {
      type: "insight",
      content: note.slice(0, 300),
      shelf: "reflections",
      tags: ["feedback", "dislike"],
    });
    this.enqueueVector({
      id: entry.id,
      content: entry.content,
      type: entry.type,
      shelf: entry.shelf,
      tags: entry.tags,
    });
  }

  /**
   * 从刚过去的那段对话里长一点经验 —— 写进 patterns 书架。
   *
   * 和 reflectOnDislike 的区别：那个是「被指出错了」才反思，是被动的；
   * 这个是每攒够一批消息就自己回头看一眼，是主动的。
   * 一个只会等别人纠正的助手长不快，因为管理员大多数时候不会明说你哪里不好。
   *
   * 走 waitUntil：复盘要跑一次维护模型，绝不能让管理员等它。
   * 整段用 try 包住由调用方兜底 —— 长不出经验是遗憾，让对话出错是事故。
   */
  private async distillExperience(): Promise<void> {
    const total = this.messages.length;
    // 懒初始化：老实例的 state 里没有 expUpto。这里退到「只回看最近一批」，
    // 而不是从 0 开始 —— 否则升级后第一次对话会把几百条历史一次性喂给模型。
    const from =
      typeof this.state.expUpto === "number"
        ? this.state.expUpto
        : Math.max(0, total - EXP_EVERY);
    if (total - from < EXP_EVERY) return;

    const slice = this.messages.slice(Math.max(from, total - EXP_WINDOW));
    const lines = slice
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map(
        (m) =>
          `${m.role === "user" ? "用户" : "我"}: ${messageText(m).slice(0, 400)}`,
      )
      .filter((s) => s.length > 8);

    // 全是工具往返、没有真正的人话，就没有什么可复盘的
    if (lines.length < 6) {
      this.patchState({ expUpto: total });
      return;
    }

    const known = listMemories(this.db, "patterns", EXP_CAP).map(
      (e) => e.content,
    );
    const out = await this.maintenance(
      experiencePrompt(known),
      lines.join("\n").slice(0, 6000),
    );
    const fresh = parseExperience(out).filter((l) => !isDuplicate(l, known));

    for (const line of fresh) {
      const entry = insertMemory(this.db, {
        type: "insight",
        content: line,
        shelf: "patterns",
        tags: ["experience"],
      });
      this.enqueueVector({
        id: entry.id,
        content: entry.content,
        type: entry.type,
        shelf: entry.shelf,
        tags: entry.tags,
      });
    }

    // 游标在成功之后才推进：这次没总结出东西，下次连同新的消息一起再看。
    this.patchState({
      expUpto: total,
      expCount: (this.state.expCount || 0) + fresh.length,
    });
  }
}
