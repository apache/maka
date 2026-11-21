import { describe, expect, it } from "vitest";
import { sortTopics } from "@/features/forum/api/client";
import type { Topic } from "@/features/forum/schemas/forum";

function makeTopic(overrides: Partial<Topic>): Topic {
  return {
    id: "t",
    title: "话题",
    categoryId: "c1",
    tags: [],
    authorId: "u1",
    participantIds: ["u1"],
    replyCount: 0,
    viewCount: 0,
    likeCount: 0,
    pinned: false,
    closed: false,
    createdAt: "2026-07-01T00:00:00Z",
    lastActivityAt: "2026-07-01T00:00:00Z",
    excerpt: "",
    ...overrides,
  };
}

describe("sortTopics", () => {
  it("置顶帖始终排在最前", () => {
    const list = [
      makeTopic({ id: "a", lastActivityAt: "2026-07-30T00:00:00Z" }),
      makeTopic({ id: "b", pinned: true, lastActivityAt: "2026-07-01T00:00:00Z" }),
      makeTopic({ id: "c", lastActivityAt: "2026-07-29T00:00:00Z" }),
    ];
    const sorted = sortTopics(list, "latest");
    expect(sorted[0].id).toBe("b");
    expect(sorted[1].id).toBe("a");
    expect(sorted[2].id).toBe("c");
  });

  it("latest 按最后活跃时间倒序", () => {
    const list = [
      makeTopic({ id: "old", lastActivityAt: "2026-07-01T00:00:00Z" }),
      makeTopic({ id: "new", lastActivityAt: "2026-07-31T00:00:00Z" }),
    ];
    expect(sortTopics(list, "latest").map((t) => t.id)).toEqual(["new", "old"]);
  });

  it("replies 按回复数倒序", () => {
    const list = [
      makeTopic({ id: "few", replyCount: 2 }),
      makeTopic({ id: "many", replyCount: 50 }),
    ];
    expect(sortTopics(list, "replies").map((t) => t.id)).toEqual(["many", "few"]);
  });
});
