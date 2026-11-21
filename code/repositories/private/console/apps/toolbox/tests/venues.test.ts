import { beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { VENUE_SEED } from "@/server/date-playbook/venues-seed";
import { createVenueRepo } from "@/server/date-playbook/venues";

describe("venue-repo（内存库）", () => {
  let repo: ReturnType<typeof createVenueRepo>;

  beforeAll(() => {
    repo = createVenueRepo(new DatabaseSync(":memory:"));
  });

  it("空库自动建表并播种，总数与种子一致", () => {
    const { items, total } = repo.list({});
    expect(total).toBe(VENUE_SEED.length);
    expect(items).toHaveLength(VENUE_SEED.length);
  });

  it("按分类筛选", () => {
    const { items } = repo.list({ category: "food_stall" });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((v) => v.category === "food_stall")).toBe(true);
  });

  it("按场景筛选", () => {
    const { items } = repo.list({ scene: "夜宵" });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((v) => v.suitableScenes.includes("夜宵"))).toBe(true);
  });

  it("收藏切换 false→true→false", () => {
    const first = repo.list({}).items[0];
    expect(first.favorite).toBe(false);
    expect(repo.toggleFavorite(first.id)).toBe(true);
    expect(repo.list({}).items.find((v) => v.id === first.id)?.favorite).toBe(true);
    expect(repo.toggleFavorite(first.id)).toBe(false);
  });

  it("只看收藏", () => {
    const first = repo.list({}).items[0];
    repo.toggleFavorite(first.id);
    const { items } = repo.list({ onlyFavorite: true });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(first.id);
    repo.toggleFavorite(first.id);
  });

  it("切换不存在的地点抛错", () => {
    expect(() => repo.toggleFavorite("venue-not-exist")).toThrow();
  });
});
