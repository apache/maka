// 情侣空间门面：仓库实现见 couple-repo.ts，应用侧单例与 venues 共库
import { createCoupleRepo } from "./couple-repo";
import { blogDb } from "./db";

export const coupleRepo = createCoupleRepo(blogDb);
export type CoupleRepo = ReturnType<typeof createCoupleRepo>;
