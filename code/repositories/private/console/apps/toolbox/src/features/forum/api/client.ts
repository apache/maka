import {
  categoryListSchema,
  postListSchema,
  topicListSchema,
  userListSchema,
  type Category,
  type Post,
  type Topic,
  type User,
} from "@/features/forum/schemas/forum";
import { categories, posts, siteStats, topics, users } from "@/features/forum/api/mock-data";
import { useForumStore } from "@/features/forum/stores/forum";
import { useAuthStore } from "@/features/forum/stores/auth";

const LATENCY = 180;

function delay<T>(data: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(data), ms));
}

function allUsers(): User[] {
  const current = useAuthStore.getState().currentUser;
  const list = current ? [...users, current] : users;
  return userListSchema.parse(list);
}

function allTopics(): Topic[] {
  const { localTopics } = useForumStore.getState();
  return topicListSchema.parse([...localTopics, ...topics]);
}

function allPosts(): Post[] {
  const { localPosts } = useForumStore.getState();
  return postListSchema.parse([...localPosts, ...posts]);
}

export type TopicSort = "latest" | "top" | "replies";

export function sortTopics(list: Topic[], sort: TopicSort): Topic[] {
  const pinned = list.filter((t) => t.pinned);
  const rest = list.filter((t) => !t.pinned);
  const sorters: Record<TopicSort, (a: Topic, b: Topic) => number> = {
    latest: (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt),
    top: (a, b) => b.likeCount + b.viewCount / 50 - (a.likeCount + a.viewCount / 50),
    replies: (a, b) => b.replyCount - a.replyCount,
  };
  return [...pinned.sort(sorters[sort]), ...rest.sort(sorters[sort])];
}

export const api = {
  async listCategories(): Promise<Category[]> {
    return delay(categoryListSchema.parse(categories));
  },

  async listTopics(options?: { categoryId?: string; sort?: TopicSort }): Promise<Topic[]> {
    let list = allTopics();
    if (options?.categoryId) {
      list = list.filter((t) => t.categoryId === options.categoryId);
    }
    return delay(sortTopics(list, options?.sort ?? "latest"));
  },

  async getTopic(id: string): Promise<Topic | undefined> {
    const topic = allTopics().find((t) => t.id === id);
    return delay(topic);
  },

  async listPosts(topicId: string): Promise<Post[]> {
    const list = allPosts()
      .filter((p) => p.topicId === topicId)
      .sort((a, b) => a.floor - b.floor);
    return delay(list);
  },

  async listUsers(): Promise<User[]> {
    return delay(allUsers());
  },

  async getStats() {
    const { localTopics, localPosts } = useForumStore.getState();
    return delay({
      ...siteStats,
      topicCount: siteStats.topicCount + localTopics.length,
      postCount: siteStats.postCount + localPosts.length,
    });
  },
};

export function findUser(userId: string): User | undefined {
  return allUsers().find((u) => u.id === userId);
}

export function findCategory(categoryId: string): Category | undefined {
  return categories.find((c) => c.id === categoryId);
}
