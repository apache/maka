import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { NewTopicInput, Post, ReplyInput, Topic, User } from "@/features/forum/schemas/forum";
import { newTopicInputSchema, replyInputSchema } from "@/features/forum/schemas/forum";

/**
 * 会话内用户产生的内容（新话题 / 回复），
 * 与内置 mock 数据叠加，构成完整的“数据库”。
 */
interface ForumState {
  localTopics: Topic[];
  localPosts: Post[];
  likedPostIds: string[];
  createTopic: (input: NewTopicInput, author: User) => Topic;
  createReply: (input: ReplyInput, author: User, floor: number) => Post;
  toggleLikePost: (postId: string) => void;
}

export const useForumStore = create<ForumState>()(
  persist(
    (set, get) => ({
      localTopics: [],
      localPosts: [],
      likedPostIds: [],
      createTopic: (rawInput, author) => {
        const input = newTopicInputSchema.parse(rawInput);
        const now = new Date().toISOString();
        const id = `local-t-${Date.now()}`;
        const topic: Topic = {
          id,
          title: input.title,
          categoryId: input.categoryId,
          tags: input.tags,
          authorId: author.id,
          participantIds: [author.id],
          replyCount: 0,
          viewCount: 1,
          likeCount: 0,
          pinned: false,
          closed: false,
          createdAt: now,
          lastActivityAt: now,
          excerpt: input.content.slice(0, 80),
        };
        const firstPost: Post = {
          id: `local-p-${Date.now()}`,
          topicId: id,
          authorId: author.id,
          floor: 1,
          content: input.content,
          likeCount: 0,
          createdAt: now,
        };
        set((s) => ({
          localTopics: [topic, ...s.localTopics],
          localPosts: [firstPost, ...s.localPosts],
        }));
        return topic;
      },
      createReply: (rawInput, author, floor) => {
        const input = replyInputSchema.parse(rawInput);
        const post: Post = {
          id: `local-p-${Date.now()}`,
          topicId: input.topicId,
          authorId: author.id,
          floor,
          content: input.content,
          likeCount: 0,
          createdAt: new Date().toISOString(),
        };
        set((s) => ({
          localPosts: [...s.localPosts, post],
          localTopics: s.localTopics.map((t) =>
            t.id === input.topicId
              ? {
                  ...t,
                  replyCount: t.replyCount + 1,
                  lastActivityAt: post.createdAt,
                  participantIds: t.participantIds.includes(author.id)
                    ? t.participantIds
                    : [...t.participantIds, author.id],
                }
              : t,
          ),
        }));
        return post;
      },
      toggleLikePost: (postId) => {
        const liked = get().likedPostIds.includes(postId);
        set((s) => ({
          likedPostIds: liked
            ? s.likedPostIds.filter((id) => id !== postId)
            : [...s.likedPostIds, postId],
        }));
      },
    }),
    { name: "ggbdpq-forum-content" },
  ),
);
