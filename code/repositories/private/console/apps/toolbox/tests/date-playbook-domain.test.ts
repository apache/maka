import { describe, beforeAll, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  canProposeStageChange,
  assertProposalReason,
  canRespondProposal,
} from "@/features/date-playbook/domain/stage/rules";
import {
  filterPartnerItems,
  paginateItems,
  groupItemsBySubcategory,
  buildArchiveTopicTree,
  findRepeatRisks,
  createEmptyArchive,
} from "@/features/date-playbook/domain/archive/rules";
import { parseFamilyTreeHtml, createEmptyFamilyTree } from "@/features/date-playbook/domain/archive/familyTree";
import { parseVisitFolderName, parseVisitFolderNames } from "@/features/date-playbook/domain/archive/visitFolders";
import { STAGE_ORDER, STAGE_LABELS, STAGE_DISCLAIMER } from "@/features/date-playbook/constants/stage";
import { CATEGORY_LABELS, SCENE_OPTIONS } from "@/features/date-playbook/constants/venue";
import { DEMO_ARCHIVE_SEED } from "@/features/date-playbook/mock/archive.demo.seed";
import { createCoupleRepo } from "@/server/date-playbook/couple-repo";
import type { PartnerFactItem } from "@/features/date-playbook/domain/types";

const item = (overrides: Partial<PartnerFactItem>): PartnerFactItem => ({
  id: "t1",
  category: "life",
  subcategory: "生活区域",
  summary: "演示摘要",
  memoryLevel: "medium",
  repeatRisk: "low",
  relationshipRelevance: "medium",
  ...overrides,
});

describe("archive/rules（迁移自 domain/archive/rules.ts）", () => {
  const items: PartnerFactItem[] = [
    item({ id: "a", summary: "她在县城上班", subcategory: "工作情况", repeatRisk: "high" }),
    item({ id: "b", summary: "住在城东", category: "life", subcategory: "生活区域" }),
    item({ id: "c", summary: "不喜欢临时改行程", category: "relationship", subcategory: "边界与雷区", repeatRisk: "high" }),
  ];

  it("filterPartnerItems 按 query/category/subcategory/repeatRisk 过滤", () => {
    expect(filterPartnerItems(items, { query: "县城" }).map((i) => i.id)).toEqual(["a"]);
    expect(filterPartnerItems(items, { category: "relationship" }).map((i) => i.id)).toEqual(["c"]);
    expect(filterPartnerItems(items, { subcategory: "生活区域" }).map((i) => i.id)).toEqual(["b"]);
    expect(filterPartnerItems(items, { repeatRisk: "high" }).map((i) => i.id)).toEqual(["a", "c"]);
    expect(filterPartnerItems(items)).toHaveLength(3);
  });

  it("paginateItems 分页并收敛越界页码", () => {
    const paged = paginateItems(items, 1, 2);
    expect(paged.totalPages).toBe(2);
    expect(paged.currentPage).toBe(1);
    expect(paged.totalItems).toBe(3);
    expect(paginateItems(items, 99, 2).currentPage).toBe(2);
    expect(paginateItems([], 0, 0).totalPages).toBe(1);
  });

  it("groupItemsBySubcategory 保持出现顺序", () => {
    const groups = groupItemsBySubcategory(items);
    expect(groups.map((g) => g.title)).toEqual(["工作情况", "生活区域", "边界与雷区"]);
  });

  it("buildArchiveTopicTree 输出关系/生活/进展三大主题", () => {
    const tree = buildArchiveTopicTree(items, [
      { id: "q1", topic: "工作节奏", answered: true },
      { id: "q2", topic: "旅行计划", answered: false },
    ]);
    expect(tree.map((n) => n.id)).toEqual(["relationship-root", "life-root", "progress-root"]);
    expect(tree[2].count).toBe(2);
    expect(tree[2].children[0].count).toBe(1);
    expect(tree[2].children[1].count).toBe(1);
  });

  it("findRepeatRisks 按关键词匹配勿重复问", () => {
    const risks = findRepeatRisks("我想问问她的工作情况", [
      { summary: "问过做什么工作，别再重复问工作", repeatRisk: "high" },
      { summary: "聊过住在哪一片", repeatRisk: "low" },
    ]);
    expect(risks).toHaveLength(1);
    expect(findRepeatRisks("  ", [])).toEqual([]);
  });

  it("createEmptyArchive 返回关闭态空档案", () => {
    const empty = createEmptyArchive("对方", "demo");
    expect(empty.enabled).toBe(false);
    expect(empty.familyTree.enabled).toBe(false);
  });
});

describe("archive/familyTree（迁移自 domain/archive/familyTree.ts）", () => {
  const FIXTURE = `<!doctype html><html><head><title>亲人图谱</title></head><body>
<h1>亲人图谱</h1>
<header class="hero"><p>家和万事兴 · 亲情永相连</p></header>
<section id="paternal-title">
  <article class="family-card">
    <div class="family-card__name">爷爷奶奶<small>（父系）</small></div>
    <div class="family-card__relation">父亲的父母</div>
    <div class="children">
      <div class="child child--boy child--self">
        <div class="child__badge">1</div>
        <div class="child__name">爸爸</div>
        <div class="child__spouse">配偶：妈妈</div>
      </div>
      <div class="grandchild">我</div>
      <div class="child child--girl">
        <div class="child__badge">2</div>
        <div class="child__name">姑姑</div>
      </div>
    </div>
  </article>
  <article class="family-card">
    <div class="family-card__name">大伯爷（已故）</div>
    <div class="children"></div>
  </article>
</section>
<section id="maternal-title">
  <article class="family-card">
    <div class="family-card__name">外公外婆</div>
    <div class="children">
      <div class="child child--girl">
        <div class="child__badge">1</div>
        <div class="child__name">妈妈</div>
      </div>
    </div>
  </article>
</section>
<footer><p>2026</p></footer>
</body></html>`;

  it("parseFamilyTreeHtml 解析称谓/性别/配偶/孙辈/已故", () => {
    const tree = parseFamilyTreeHtml(FIXTURE);
    expect(tree.enabled).toBe(true);
    expect(tree.title).toBe("亲人图谱");
    expect(tree.motto).toBe("家和万事兴 · 亲情永相连");
    expect(tree.year).toBe("2026");
    expect(tree.paternal).toHaveLength(2);
    const first = tree.paternal[0];
    expect(first.title).toBe("爷爷奶奶");
    expect(first.relationNote).toBe("父亲的父母");
    expect(first.children[0]).toMatchObject({ order: 1, gender: "boy", name: "爸爸", spouse: "妈妈", isSelf: true });
    expect(first.children[0].grandchildren).toEqual([{ label: "我" }]);
    expect(tree.paternal[1].deceased).toBe(true);
    expect(tree.maternal[0].children[0].gender).toBe("girl");
  });

  it("createEmptyFamilyTree 返回关闭态", () => {
    expect(createEmptyFamilyTree().enabled).toBe(false);
  });
});

describe("archive/visitFolders（迁移自 domain/archive/visitFolders.ts）", () => {
  it("解析 chat-memory 目录名为见面记忆", () => {
    expect(parseVisitFolderName("20260218-年初二-在家吃饭&&晚上去她大姑家烧烤")).toEqual({
      date: "2026-02-18",
      title: "年初二",
      content: "在家吃饭；晚上去她大姑家烧烤",
    });
  });
  it("跳过名单与非法目录名", () => {
    expect(parseVisitFolderName("交通与距离")).toBeNull();
    expect(parseVisitFolderName("videos")).toBeNull();
    expect(parseVisitFolderName("无日期目录")).toBeNull();
    expect(parseVisitFolderName("")).toBeNull();
  });
  it("批量解析并按日期排序", () => {
    const visits = parseVisitFolderNames([
      "20260307-周六-老街拍照",
      "20260218-年初二-在家吃饭",
      "交通与距离",
    ]);
    expect(visits.map((v) => v.date)).toEqual(["2026-02-18", "2026-03-07"]);
  });
});

describe("stage 规则与常量（迁移自 domain/stage/rules + constants）", () => {
  it("canProposeStageChange 允许前后移动，禁止原地变更", () => {
    expect(canProposeStageChange("stable_chat", "first_date")).toBe(true);
    expect(canProposeStageChange("first_date", "stable_chat")).toBe(true);
    expect(canProposeStageChange("stable_chat", "stable_chat")).toBe(false);
    expect(canProposeStageChange("unknown" as never, "stable_chat")).toBe(false);
  });

  it("assertProposalReason 要求非空事实依据", () => {
    expect(() => assertProposalReason("  ")).toThrow("阶段变更必须填写一句事实依据");
    expect(() => assertProposalReason("连续见面三次")).not.toThrow();
  });

  it("canRespondProposal 要求 pending 且响应者不是发起者", () => {
    const proposal = {
      id: "p1", coupleId: "c1", fromStage: "stable_chat" as const, toStage: "first_date" as const,
      reason: "r", proposerId: "user-a", status: "pending" as const, createdAt: "2026-01-01",
    };
    expect(canRespondProposal(proposal, "user-b")).toBe(true);
    expect(canRespondProposal(proposal, "user-a")).toBe(false);
    expect(canRespondProposal({ ...proposal, status: "accepted" }, "user-b")).toBe(false);
  });

  it("constants/stage：九阶段顺序、标签与免责语", () => {
    expect(STAGE_ORDER).toHaveLength(9);
    expect(STAGE_ORDER[0]).toBe("initial_contact");
    expect(STAGE_ORDER[8]).toBe("stable_relationship");
    expect(STAGE_LABELS.relationship_confirmed).toBe("确认关系");
    expect(STAGE_DISCLAIMER).toBe("阶段只是共同记录，需要以真实沟通为准");
  });

  it("constants/venue：分类标签与场景选项", () => {
    expect(CATEGORY_LABELS.snack).toBe("小吃");
    expect(SCENE_OPTIONS).toContain("夜宵");
  });
});

describe("demo 档案种子（自拟演示数据，不含私人内容）", () => {
  it("默认开启且标注演示数据，含见面记忆与家庭树", () => {
    expect(DEMO_ARCHIVE_SEED.enabled).toBe(true);
    expect(DEMO_ARCHIVE_SEED.source).toBe("demo");
    expect(DEMO_ARCHIVE_SEED.items.every((i) => i.summary.includes("演示数据"))).toBe(true);
    expect(DEMO_ARCHIVE_SEED.visits.length).toBeGreaterThan(0);
    expect(DEMO_ARCHIVE_SEED.familyTree.enabled).toBe(true);
    expect(DEMO_ARCHIVE_SEED.askedTopics.length).toBeGreaterThan(0);
    expect(DEMO_ARCHIVE_SEED.doNotRepeat.length).toBeGreaterThan(0);
  });
});

describe("couple-repo 扩展：退回原因 / 九阶段提案（内存库）", () => {
  let repo: ReturnType<typeof createCoupleRepo>;
  let coupleId: string;

  beforeAll(() => {
    repo = createCoupleRepo(new DatabaseSync(":memory:"));
    const couple = repo.createCouple("演示小家", "user-a");
    repo.joinCouple(couple.inviteCode, "user-b");
    coupleId = couple.id;
  });

  it("计划创建即送确认（submit），创建人不能确认自己的计划", () => {
    const plan = repo.createPlan(
      coupleId,
      "user-a",
      { title: "夜市散步", date: "2026-09-05", venueIds: ["venue-yes-market"], startTime: "18:00", estimatedBudget: 120, topics: ["近况"], bookingRequired: false },
      { submit: true },
    );
    expect(plan.status).toBe("pending_confirmation");
    expect(plan.startTime).toBe("18:00");
    expect(plan.estimatedBudget).toBe(120);
    expect(() => repo.transitionPlan(plan.id, "user-a", "confirmed")).toThrow("创建人不能确认自己发起的计划");
    repo.transitionPlan(plan.id, "user-b", "confirmed");
    expect(repo.getPlan(plan.id)?.status).toBe("confirmed");
  });

  it("退回必须填写原因，原因随计划保存", () => {
    const plan = repo.createPlan(coupleId, "user-a", { title: "海边日落", date: "2026-09-10", venueIds: ["v2"] }, { submit: true });
    expect(() => repo.rejectPlan(plan.id, "user-b", "   ")).toThrow("退回修改必须填写一句原因");
    const rejected = repo.rejectPlan(plan.id, "user-b", "那天我加班，换一天吧");
    expect(rejected.status).toBe("draft");
    expect(rejected.rejectReason).toBe("那天我加班，换一天吧");
  });

  it("九阶段提案：发起→对方确认→currentStage 更新；拒绝不更新", () => {
    const proposal = repo.createStageProposal(coupleId, "user-a", "stable_chat", "每天都会分享日常");
    expect(proposal.fromStage).toBe("initial_contact");
    expect(proposal.status).toBe("pending");
    expect(() => repo.createStageProposal(coupleId, "user-a", "initial_contact", "原地变更")).toThrow();
    expect(() => repo.createStageProposal(coupleId, "user-a", "first_date", "")).toThrow("阶段变更必须填写一句事实依据");
    expect(() => repo.respondStageProposal(proposal.id, "user-a", true)).toThrow("发起者不能响应自己的提案");
    const declined = repo.createStageProposal(coupleId, "user-b", "stable_relationship", "跳太快了");
    repo.respondStageProposal(declined.id, "user-a", false);
    expect(repo.listStageProposals(coupleId).find((p) => p.id === declined.id)?.status).toBe("rejected");
    const done = repo.respondStageProposal(proposal.id, "user-b", true);
    expect(done.status).toBe("accepted");
    expect(done.responderId).toBe("user-b");
    expect(repo.getCouple(coupleId).currentStage).toBe("stable_chat");
    const list = repo.listStageProposals(coupleId);
    expect(list).toHaveLength(2);
  });
});
