import { DatabaseSync } from "node:sqlite";
import {
  coupleSchema,
  favoriteRecordSchema,
  planSchema,
  proposalSchema,
  reviewSchema,
  stageProposalSchema,
  timelineEventSchema,
  stageSchema,
  type Couple,
  type FavoriteRecord,
  type Plan,
  type Proposal,
  type Review,
  type StageProposal,
  type TimelineEvent,
} from "@/schemas/date-playbook";
import type { RelationshipStage } from "@/features/date-playbook/domain/types";
import { STAGE_LABELS, STAGE_ORDER } from "@/features/date-playbook/constants/stage";
import {
  assertProposalReason,
  canProposeStageChange,
  canRespondProposal,
} from "@/features/date-playbook/domain/stage/rules";
import { assertTransition } from "./plan-machine";

// 情侣空间数据域：couples/plans/reviews/proposals/timeline 五表，node:sqlite。
// 领域规则迁移自 miniapp couple/rules + stage/rules + plan/statusMachine。
// db 注入是测试面（:memory: 全链路验证）。
//
// 数据面扩展（对齐源 DatePlan/DateReview/StageProposal/Favorite）：
// - plans 补源字段（起止时间/集合/预算/话题/注意/备用方案/预约标记）+ 退回原因
// - couples 补 current_stage（九阶段）；stage_proposals 表走源提案流程
// - reviews 补 user_id/willing_again/message_to_partner，双方提交后追加共同时间线
// - favorites 表对齐源 Favorite（want_to_go/visited 互斥，同状态再点即取消）

const MAX_COUPLE_MEMBERS = 2;

/** 老库平滑迁移：缺列时 ALTER TABLE 补齐（新库建表已含全部列，此处幂等） */
function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
  }
}

interface CoupleRow {
  id: string;
  name: string;
  invite_code: string;
  member_ids: string;
  current_stage: string | null;
  relationship_start_date: string | null;
  created_at: string;
}
interface PlanRow {
  id: string;
  couple_id: string;
  created_by: string;
  title: string;
  date: string;
  venue_ids: string;
  status: string;
  start_time: string | null;
  end_time: string | null;
  meeting_note: string | null;
  estimated_budget: number | null;
  topics: string | null;
  cautions: string | null;
  backup_plan: string | null;
  booking_required: number | null;
  reject_reason: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
}
interface ReviewRow {
  id: string;
  plan_id: string;
  couple_id: string;
  author: string;
  rating: number;
  highlights: string;
  improvements: string;
  user_id: string | null;
  willing_again: number | null;
  message_to_partner: string | null;
  created_at: string;
}
interface ProposalRow {
  id: string;
  couple_id: string;
  proposer: string;
  to_stage: string;
  reason: string;
  status: string;
  created_at: string;
}
interface StageProposalRow {
  id: string;
  couple_id: string;
  from_stage: string;
  to_stage: string;
  reason: string;
  proposer_id: string;
  status: string;
  responder_id: string | null;
  responded_at: string | null;
  created_at: string;
}
interface FavoriteRow {
  id: string;
  couple_id: string;
  venue_id: string;
  user_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}
interface EventRow {
  id: string;
  couple_id: string;
  at: string;
  actor: string;
  type: string;
  detail: string;
}

/** 计划创建入参：对齐源 datePlanFormSchema 的存储字段（remark 表单字段源类型不持久化） */
export interface CreatePlanInput {
  title: string;
  date: string;
  venueIds: string[];
  startTime?: string;
  endTime?: string;
  meetingNote?: string;
  estimatedBudget?: number;
  topics?: string[];
  cautions?: string[];
  backupPlan?: string;
  bookingRequired?: boolean;
}

export function createCoupleRepo(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS couples (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE,
      member_ids TEXT NOT NULL, current_stage TEXT, relationship_start_date TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY, couple_id TEXT NOT NULL, created_by TEXT NOT NULL,
      title TEXT NOT NULL, date TEXT NOT NULL, venue_ids TEXT NOT NULL,
      status TEXT NOT NULL,
      start_time TEXT, end_time TEXT, meeting_note TEXT, estimated_budget REAL,
      topics TEXT, cautions TEXT, backup_plan TEXT, booking_required INTEGER,
      reject_reason TEXT, confirmed_by TEXT, confirmed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, couple_id TEXT NOT NULL,
      author TEXT NOT NULL, rating INTEGER NOT NULL, highlights TEXT NOT NULL,
      improvements TEXT NOT NULL, user_id TEXT, willing_again INTEGER,
      message_to_partner TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY, couple_id TEXT NOT NULL, proposer TEXT NOT NULL,
      to_stage TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stage_proposals (
      id TEXT PRIMARY KEY, couple_id TEXT NOT NULL, from_stage TEXT NOT NULL,
      to_stage TEXT NOT NULL, reason TEXT NOT NULL, proposer_id TEXT NOT NULL,
      status TEXT NOT NULL, responder_id TEXT, responded_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorites (
      id TEXT PRIMARY KEY, couple_id TEXT NOT NULL, venue_id TEXT NOT NULL,
      user_id TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (couple_id, venue_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY, couple_id TEXT NOT NULL, at TEXT NOT NULL,
      actor TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL
    );
  `);
  // 已存在的库补列（PRAGMA 校验，幂等）
  ensureColumn(db, "couples", "current_stage", "current_stage TEXT");
  ensureColumn(db, "couples", "relationship_start_date", "relationship_start_date TEXT");
  ensureColumn(db, "plans", "start_time", "start_time TEXT");
  ensureColumn(db, "plans", "end_time", "end_time TEXT");
  ensureColumn(db, "plans", "meeting_note", "meeting_note TEXT");
  ensureColumn(db, "plans", "estimated_budget", "estimated_budget REAL");
  ensureColumn(db, "plans", "topics", "topics TEXT");
  ensureColumn(db, "plans", "cautions", "cautions TEXT");
  ensureColumn(db, "plans", "backup_plan", "backup_plan TEXT");
  ensureColumn(db, "plans", "booking_required", "booking_required INTEGER");
  ensureColumn(db, "plans", "reject_reason", "reject_reason TEXT");
  ensureColumn(db, "plans", "confirmed_by", "confirmed_by TEXT");
  ensureColumn(db, "plans", "confirmed_at", "confirmed_at TEXT");
  ensureColumn(db, "reviews", "user_id", "user_id TEXT");
  ensureColumn(db, "reviews", "willing_again", "willing_again INTEGER");
  ensureColumn(db, "reviews", "message_to_partner", "message_to_partner TEXT");

  const now = () => new Date().toISOString();
  const genId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const getCoupleRow = (id: string): CoupleRow => {
    const row = db.prepare("SELECT * FROM couples WHERE id = ?").get(id) as CoupleRow | undefined;
    if (!row) throw new Error(`情侣空间不存在：${id}`);
    return row;
  };
  const parseCouple = (row: CoupleRow): Couple =>
    coupleSchema.parse({ id: row.id, name: row.name, memberIds: JSON.parse(row.member_ids), inviteCode: row.invite_code, currentStage: row.current_stage ?? undefined, relationshipStartDate: row.relationship_start_date ?? undefined, createdAt: row.created_at });

  /** 找到用户所在的两人空间；没有则抛源文案错误 */
  const findCoupleByUser = (userId: string): Couple => {
    const couple = (db.prepare("SELECT * FROM couples ORDER BY created_at").all() as unknown as CoupleRow[])
      .map(parseCouple)
      .find((c) => c.memberIds.includes(userId));
    if (!couple) throw new Error("请先创建或加入两人空间");
    return couple;
  };

  const assertMember = (coupleId: string, userId: string): Couple => {
    const couple = parseCouple(getCoupleRow(coupleId));
    if (!couple.memberIds.includes(userId)) {
      throw new Error("当前用户不属于该两人空间，禁止写入共享数据");
    }
    return couple;
  };
  const addEvent = (coupleId: string, actor: string, type: string, detail: string) => {
    db.prepare("INSERT INTO timeline_events (id, couple_id, at, actor, type, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(genId("evt"), coupleId, now(), actor, type, detail);
  };
  const getPlanRow = (id: string): PlanRow => {
    const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
    if (!row) throw new Error(`计划不存在：${id}`);
    return row;
  };
  const parsePlan = (row: PlanRow): Plan =>
    planSchema.parse({
      id: row.id, coupleId: row.couple_id, createdBy: row.created_by, title: row.title,
      date: row.date, venueIds: JSON.parse(row.venue_ids), status: row.status, createdAt: row.created_at,
      startTime: row.start_time ?? undefined,
      endTime: row.end_time ?? undefined,
      meetingNote: row.meeting_note ?? undefined,
      estimatedBudget: row.estimated_budget ?? undefined,
      topics: row.topics ? (JSON.parse(row.topics) as string[]) : [],
      cautions: row.cautions ? (JSON.parse(row.cautions) as string[]) : [],
      backupPlan: row.backup_plan ?? undefined,
      bookingRequired: row.booking_required === 1,
      rejectReason: row.reject_reason ?? undefined,
      confirmedBy: row.confirmed_by ?? undefined,
      confirmedAt: row.confirmed_at ?? undefined,
    });
  const parseReview = (r: ReviewRow): Review =>
    reviewSchema.parse({
      id: r.id, planId: r.plan_id, coupleId: r.couple_id, author: r.author,
      rating: r.rating, highlights: r.highlights, improvements: r.improvements,
      userId: r.user_id ?? undefined,
      feeling: r.rating,
      favoritePart: r.highlights,
      regretPart: r.improvements || undefined,
      willingAgain: r.willing_again === null ? undefined : r.willing_again === 1,
      messageToPartner: r.message_to_partner ?? undefined,
      createdAt: r.created_at,
    });

  return {
    createCouple(name: string, userId: string): Couple {
      const id = genId("couple");
      const inviteCode = String(Math.floor(100000 + Math.random() * 900000));
      db.prepare("INSERT INTO couples (id, name, invite_code, member_ids, current_stage, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, name, inviteCode, JSON.stringify([userId]), "initial_contact", now());
      const couple = parseCouple(getCoupleRow(id));
      addEvent(id, userId, "couple.create", `创建两人空间「${name}」`);
      return couple;
    },

    listCouples(): Couple[] {
      const rows = db.prepare("SELECT * FROM couples ORDER BY created_at").all() as unknown as CoupleRow[];
      return rows.map(parseCouple);
    },

    getCouple(id: string): Couple {
      return parseCouple(getCoupleRow(id));
    },

    joinCouple(inviteCode: string, userId: string): Couple {
      const row = db.prepare("SELECT * FROM couples WHERE invite_code = ?").get(inviteCode) as CoupleRow | undefined;
      if (!row) throw new Error(`邀请码无效：${inviteCode}`);
      const couple = parseCouple(row);
      if (couple.memberIds.includes(userId)) return couple;
      if (couple.memberIds.length >= MAX_COUPLE_MEMBERS) throw new Error("两人空间已满");
      const memberIds = [...couple.memberIds, userId];
      db.prepare("UPDATE couples SET member_ids = ? WHERE id = ?").run(JSON.stringify(memberIds), couple.id);
      addEvent(couple.id, userId, "couple.join", "另一半加入了空间");
      return { ...couple, memberIds };
    },

    /** 创建计划；opts.submit 对齐源 plan-edit「提交给对方确认」（直接进入待确认） */
    createPlan(coupleId: string, userId: string, input: CreatePlanInput, opts?: { submit?: boolean }): Plan {
      assertMember(coupleId, userId);
      const id = genId("plan");
      const status = opts?.submit ? "pending_confirmation" : "draft";
      db.prepare(
        `INSERT INTO plans (id, couple_id, created_by, title, date, venue_ids, status,
          start_time, end_time, meeting_note, estimated_budget, topics, cautions,
          backup_plan, booking_required, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, coupleId, userId, input.title, input.date, JSON.stringify(input.venueIds), status,
        input.startTime || null, input.endTime || null, input.meetingNote || null,
        input.estimatedBudget ?? null, JSON.stringify(input.topics ?? []), JSON.stringify(input.cautions ?? []),
        input.backupPlan || null, input.bookingRequired ? 1 : 0, now(),
      );
      addEvent(coupleId, userId, status === "draft" ? "plan.create" : "plan.pending_confirmation",
        status === "draft" ? `发起计划「${input.title}」（${input.date}）` : `提交计划「${input.title}」等待确认（${input.date}）`);
      return parsePlan(getPlanRow(id));
    },

    getPlan(id: string): Plan | undefined {
      const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
      return row ? parsePlan(row) : undefined;
    },

    /** 编辑计划（源 plan-edit：仅草稿态可改；改完可直接再提交） */
    updatePlan(planId: string, userId: string, input: CreatePlanInput, opts?: { submit?: boolean }): Plan {
      const row = getPlanRow(planId);
      assertMember(row.couple_id, userId);
      if (row.status !== "draft") throw new Error("只有草稿状态的计划可以编辑");
      const status = opts?.submit ? "pending_confirmation" : "draft";
      db.prepare(
        `UPDATE plans SET title = ?, date = ?, venue_ids = ?, status = ?,
          start_time = ?, end_time = ?, meeting_note = ?, estimated_budget = ?,
          topics = ?, cautions = ?, backup_plan = ?, booking_required = ? WHERE id = ?`,
      ).run(
        input.title, input.date, JSON.stringify(input.venueIds), status,
        input.startTime || null, input.endTime || null, input.meetingNote || null,
        input.estimatedBudget ?? null, JSON.stringify(input.topics ?? []), JSON.stringify(input.cautions ?? []),
        input.backupPlan || null, input.bookingRequired ? 1 : 0, planId,
      );
      if (opts?.submit) {
        addEvent(row.couple_id, userId, "plan.pending_confirmation", `重新提交计划「${input.title}」等待确认`);
      } else {
        addEvent(row.couple_id, userId, "plan.edit", `编辑了计划「${input.title}」`);
      }
      return parsePlan(getPlanRow(planId));
    },

    listPlans(coupleId: string): Plan[] {
      const rows = db.prepare("SELECT * FROM plans WHERE couple_id = ? ORDER BY date DESC").all(coupleId) as unknown as PlanRow[];
      return rows.map(parsePlan);
    },

    /** 状态流转；opts.reason 在退回 draft 时记录退回原因（数据面对齐任务要求） */
    transitionPlan(planId: string, userId: string, to: Plan["status"], opts?: { reason?: string }): Plan {
      const row = getPlanRow(planId);
      assertMember(row.couple_id, userId);
      if (to === "confirmed" && row.created_by === userId) {
        throw new Error("创建人不能确认自己发起的计划");
      }
      assertTransition(row.status as Plan["status"], to);
      if (to === "confirmed") {
        db.prepare("UPDATE plans SET status = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ?")
          .run(to, userId, now(), planId);
      } else if (to === "draft") {
        db.prepare("UPDATE plans SET status = ?, reject_reason = ? WHERE id = ?")
          .run(to, opts?.reason ?? null, planId);
      } else {
        db.prepare("UPDATE plans SET status = ? WHERE id = ?").run(to, planId);
      }
      const labels: Record<string, string> = { draft: "退回草稿", pending_confirmation: "送出确认", confirmed: "确认计划", completed: "完成约会", cancelled: "取消计划" };
      addEvent(row.couple_id, userId, `plan.${to}`, `${labels[to]}「${row.title}」${opts?.reason ? `（原因：${opts.reason}）` : ""}`);
      return parsePlan(getPlanRow(planId));
    },

    /** 退回修改（源 rejectPlan：必须填写一句原因） */
    rejectPlan(planId: string, userId: string, reason: string): Plan {
      if (!reason || reason.trim().length === 0) throw new Error("退回修改必须填写一句原因");
      return this.transitionPlan(planId, userId, "draft", { reason: reason.trim() });
    },

    /** 提交复盘：兼容旧 {rating,highlights,improvements} 与源 {feeling,favoritePart,...} 两种形态 */
    submitReview(planId: string, userId: string, input: {
      rating?: number; highlights?: string; improvements?: string;
      feeling?: number; favoritePart?: string; regretPart?: string;
      willingAgain?: boolean; messageToPartner?: string;
    }): Review {
      const planRow = getPlanRow(planId);
      assertMember(planRow.couple_id, userId);
      const feeling = input.feeling ?? input.rating;
      if (feeling === undefined) throw new Error("缺少整体感受评分");
      const favoritePart = input.favoritePart ?? input.highlights ?? "";
      if (input.feeling !== undefined && !favoritePart.trim()) throw new Error("请填写最喜欢的环节");
      const existing = db.prepare("SELECT user_id FROM reviews WHERE plan_id = ?").all(planId) as unknown as Array<{ user_id: string | null }>;
      if (existing.some((r) => r.user_id === userId)) throw new Error("你已经提交过这次约会的复盘");
      const review = reviewSchema.parse({
        id: genId("review"), planId, coupleId: planRow.couple_id, author: userId,
        rating: feeling, highlights: favoritePart, improvements: input.regretPart ?? input.improvements ?? "",
        userId, feeling, favoritePart,
        regretPart: input.regretPart ?? undefined,
        willingAgain: input.willingAgain ?? undefined,
        messageToPartner: input.messageToPartner || undefined,
        createdAt: now(),
      });
      db.prepare(
        `INSERT INTO reviews (id, plan_id, couple_id, author, rating, highlights, improvements,
          user_id, willing_again, message_to_partner, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        review.id, review.planId, review.coupleId, review.author, review.rating,
        review.highlights, review.improvements, userId,
        review.willingAgain === undefined ? null : review.willingAgain ? 1 : 0,
        review.messageToPartner ?? null, review.createdAt,
      );
      addEvent(planRow.couple_id, userId, "review.create", `复盘了「${planRow.title}」（${feeling} 星）`);
      // 对齐源：双方都提交后追加共同时间线
      const members = (JSON.parse(getCoupleRow(planRow.couple_id).member_ids) as string[]) ?? [];
      if (members.length > 0 && members.every((m) => existing.some((r) => r.user_id === m) || m === userId)) {
        addEvent(planRow.couple_id, userId, "review.create", `双方完成了「${planRow.title}」的复盘`);
      }
      return review;
    },

    listReviews(planId: string): Review[] {
      const rows = db.prepare("SELECT * FROM reviews WHERE plan_id = ? ORDER BY created_at").all(planId) as unknown as ReviewRow[];
      return rows.map(parseReview);
    },

    createProposal(coupleId: string, userId: string, toStage: string, reason: string): Proposal {
      assertMember(coupleId, userId);
      if (!reason.trim()) throw new Error("阶段变更必须填写一句事实依据");
      const stage = stageSchema.parse(toStage);
      const proposal = proposalSchema.parse({
        id: genId("prop"), coupleId, proposer: userId, toStage: stage, reason: reason.trim(),
        status: "pending", createdAt: now(),
      });
      db.prepare("INSERT INTO proposals (id, couple_id, proposer, to_stage, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(proposal.id, proposal.coupleId, proposal.proposer, proposal.toStage, proposal.reason, proposal.status, proposal.createdAt);
      addEvent(coupleId, userId, "proposal.create", `提议将关系推进到「${stage}」`);
      return proposal;
    },

    listProposals(coupleId: string): Proposal[] {
      const rows = db.prepare("SELECT * FROM proposals WHERE couple_id = ? ORDER BY created_at DESC").all(coupleId) as unknown as ProposalRow[];
      return rows.map((r) => proposalSchema.parse(r));
    },

    /** 阶段变更必须由另一方确认才生效（响应者不能是发起者） */
    respondProposal(proposalId: string, responderId: string, accept: boolean): Proposal {
      const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposalId) as ProposalRow | undefined;
      if (!row) throw new Error(`提案不存在：${proposalId}`);
      if (row.status !== "pending") throw new Error("提案已处理");
      if (row.proposer === responderId) throw new Error("发起者不能响应自己的提案");
      const status = accept ? "accepted" : "declined";
      db.prepare("UPDATE proposals SET status = ? WHERE id = ?").run(status, proposalId);
      addEvent(row.couple_id, responderId, `proposal.${status}`, `${accept ? "同意" : "婉拒"}了阶段推进「${row.to_stage}」`);
      return proposalSchema.parse({
        id: row.id, coupleId: row.couple_id, proposer: row.proposer, toStage: row.to_stage,
        reason: row.reason, status, createdAt: row.created_at,
      });
    },

    // ===== 源九阶段提案（stage-proposal 页）=====

    listStageProposals(coupleId: string): StageProposal[] {
      const rows = db.prepare("SELECT * FROM stage_proposals WHERE couple_id = ? ORDER BY created_at DESC").all(coupleId) as unknown as StageProposalRow[];
      return rows.map((r) =>
        stageProposalSchema.parse({
          id: r.id, coupleId: r.couple_id, fromStage: r.from_stage, toStage: r.to_stage,
          reason: r.reason, proposerId: r.proposer_id, status: r.status,
          responderId: r.responder_id ?? undefined, respondedAt: r.responded_at ?? undefined,
          createdAt: r.created_at,
        }),
      );
    },

    /** 发起九阶段变更：fromStage 由当前空间阶段推导（对齐源 repo） */
    createStageProposal(coupleId: string, userId: string, toStage: string, reason: string): StageProposal {
      const couple = assertMember(coupleId, userId);
      const fromStage = couple.currentStage ?? "initial_contact";
      if (!(STAGE_ORDER as readonly string[]).includes(toStage)) throw new Error(`未知阶段：${toStage}`);
      if (!canProposeStageChange(fromStage, toStage as RelationshipStage)) {
        throw new Error("目标阶段不能与当前阶段相同");
      }
      assertProposalReason(reason);
      const proposal = stageProposalSchema.parse({
        id: genId("sprop"), coupleId, fromStage, toStage, reason: reason.trim(),
        proposerId: userId, status: "pending", createdAt: now(),
      });
      db.prepare(
        "INSERT INTO stage_proposals (id, couple_id, from_stage, to_stage, reason, proposer_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(proposal.id, coupleId, fromStage, proposal.toStage, proposal.reason, userId, "pending", proposal.createdAt);
      addEvent(coupleId, userId, "proposal.create", `提议将关系从「${STAGE_LABELS[fromStage]}」变更为「${STAGE_LABELS[proposal.toStage]}」`);
      return proposal;
    },

    /** 响应九阶段提案：同意后 couples.current_stage 更新（允许前进和回退） */
    respondStageProposal(proposalId: string, responderId: string, accept: boolean): StageProposal {
      const row = db.prepare("SELECT * FROM stage_proposals WHERE id = ?").get(proposalId) as StageProposalRow | undefined;
      if (!row) throw new Error(`提案不存在：${proposalId}`);
      const current = {
        id: row.id, coupleId: row.couple_id, fromStage: row.from_stage, toStage: row.to_stage,
        reason: row.reason, proposerId: row.proposer_id, status: row.status, createdAt: row.created_at,
      } as StageProposal;
      if (!canRespondProposal(current, responderId)) {
        if (row.status !== "pending") throw new Error("提案已处理");
        throw new Error("发起者不能响应自己的提案");
      }
      const status = accept ? "accepted" : "rejected";
      const respondedAt = now();
      db.prepare("UPDATE stage_proposals SET status = ?, responder_id = ?, responded_at = ? WHERE id = ?")
        .run(status, responderId, respondedAt, proposalId);
      if (accept) {
        db.prepare("UPDATE couples SET current_stage = ? WHERE id = ?").run(row.to_stage, row.couple_id);
      }
      addEvent(row.couple_id, responderId, `proposal.${status}`,
        `${accept ? "同意" : "婉拒"}了阶段变更「${STAGE_LABELS[row.from_stage as keyof typeof STAGE_LABELS]} → ${STAGE_LABELS[row.to_stage as keyof typeof STAGE_LABELS]}」`);
      return stageProposalSchema.parse({
        ...current, status, responderId, respondedAt,
      });
    },

    // ===== 收藏（源 Favorite：want_to_go/visited 互斥，同状态再点即取消）=====

    setFavorite(userId: string, venueId: string, status: "want_to_go" | "visited" | "none"): FavoriteRecord | null {
      const couple = findCoupleByUser(userId);
      const existing = db
        .prepare("SELECT * FROM favorites WHERE couple_id = ? AND venue_id = ? AND user_id = ?")
        .get(couple.id, venueId, userId) as FavoriteRow | undefined;
      if (status === "none" || (existing && existing.status === status)) {
        db.prepare("DELETE FROM favorites WHERE id = ?").run(existing?.id ?? "");
        return null;
      }
      const ts = now();
      if (existing) {
        db.prepare("UPDATE favorites SET status = ?, updated_at = ? WHERE id = ?").run(status, ts, existing.id);
      } else {
        db.prepare("INSERT INTO favorites (id, couple_id, venue_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(genId("fav"), couple.id, venueId, userId, status, ts, ts);
      }
      const row = db.prepare("SELECT * FROM favorites WHERE couple_id = ? AND venue_id = ? AND user_id = ?")
        .get(couple.id, venueId, userId) as unknown as FavoriteRow;
      return favoriteRecordSchema.parse({
        id: row.id, coupleId: row.couple_id, venueId: row.venue_id, userId: row.user_id,
        status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
      });
    },

    listTimeline(coupleId: string): TimelineEvent[] {
      const rows = db.prepare("SELECT * FROM timeline_events WHERE couple_id = ? ORDER BY at DESC").all(coupleId) as unknown as EventRow[];
      return rows.map((r) =>
        timelineEventSchema.parse({
          id: r.id, coupleId: r.couple_id, at: r.at, actor: r.actor, type: r.type, detail: r.detail,
        }),
      );
    },
  };
}
