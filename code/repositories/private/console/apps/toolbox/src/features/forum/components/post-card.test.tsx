// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PostCard } from "@/features/forum/components/post-card";
import { UserAvatar } from "@/features/forum/components/user-avatar";
import type { Post } from "@/features/forum/schemas/forum";

describe("UserAvatar", () => {
  it("渲染中文昵称缩写", () => {
    render(<UserAvatar user={{ nickname: "调试猫", color: "#db2777" }} />);
    expect(screen.getByLabelText("调试猫")).toHaveTextContent("试猫");
  });
});

describe("PostCard", () => {
  const post: Post = {
    id: "p1-1",
    topicId: "t1",
    authorId: "u1",
    floor: 1,
    content: "大家好，**这是加粗**，@调试猫 你觉得呢？",
    likeCount: 10,
    createdAt: new Date().toISOString(),
  };

  it("渲染作者与楼层", () => {
    render(<PostCard post={post} />);
    expect(screen.getByText("ggbdpq")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
  });

  it("加粗与提及被正确渲染", () => {
    const { container } = render(<PostCard post={post} />);
    expect(container.querySelector("strong")).toHaveTextContent("这是加粗");
    expect(screen.getByText("@调试猫")).toBeInTheDocument();
  });

  it("未知作者不渲染", () => {
    const { container } = render(<PostCard post={{ ...post, authorId: "nobody" }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
