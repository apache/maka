import { z } from "zod";

export const userSchema = z.object({
  id: z.string(),
  username: z.string().min(1),
  nickname: z.string().min(1),
  title: z.string().default(""),
  trustLevel: z.number().int().min(0).max(4),
  postCount: z.number().int().nonnegative(),
  joinedAt: z.string(),
  isAdmin: z.boolean().default(false),
  color: z.string().default("#3b82f6"),
});
export type User = z.infer<typeof userSchema>;

export const categorySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  color: z.string(),
  topicCount: z.number().int().nonnegative(),
  postCount: z.number().int().nonnegative(),
});
export type Category = z.infer<typeof categorySchema>;

export const topicSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  categoryId: z.string(),
  tags: z.array(z.string()),
  authorId: z.string(),
  participantIds: z.array(z.string()),
  replyCount: z.number().int().nonnegative(),
  viewCount: z.number().int().nonnegative(),
  likeCount: z.number().int().nonnegative(),
  pinned: z.boolean().default(false),
  closed: z.boolean().default(false),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  excerpt: z.string().default(""),
});
export type Topic = z.infer<typeof topicSchema>;

export const postSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  authorId: z.string(),
  floor: z.number().int().positive(),
  content: z.string().min(1),
  likeCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type Post = z.infer<typeof postSchema>;

export const topicListSchema = z.array(topicSchema);
export const postListSchema = z.array(postSchema);
export const categoryListSchema = z.array(categorySchema);
export const userListSchema = z.array(userSchema);

/** 发布新话题的表单校验 */
export const newTopicInputSchema = z.object({
  title: z
    .string()
    .min(5, "标题至少 5 个字符")
    .max(80, "标题最多 80 个字符"),
  categoryId: z.string().min(1, "请选择一个分类"),
  tags: z.array(z.string()).max(5, "最多 5 个标签"),
  content: z.string().min(20, "正文至少 20 个字符"),
});
export type NewTopicInput = z.infer<typeof newTopicInputSchema>;

/** 回复表单校验 */
export const replyInputSchema = z.object({
  topicId: z.string(),
  content: z.string().min(5, "回复至少 5 个字符"),
});
export type ReplyInput = z.infer<typeof replyInputSchema>;
