import { describe, expect, it } from "vitest";
import { useAuthStore } from "@/features/forum/stores/auth";

describe("useAuthStore", () => {
  it("初始未登录", () => {
    expect(useAuthStore.getState().currentUser).toBeNull();
  });

  it("登录后写入用户信息", () => {
    useAuthStore.getState().login("tester");
    const user = useAuthStore.getState().currentUser;
    expect(user).not.toBeNull();
    expect(user?.nickname).toBe("tester");
    expect(user?.trustLevel).toBe(0);
  });

  it("空白用户名不产生登录", () => {
    useAuthStore.getState().logout();
    useAuthStore.getState().login("   ");
    expect(useAuthStore.getState().currentUser).toBeNull();
  });

  it("退出登录", () => {
    useAuthStore.getState().login("tester");
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().currentUser).toBeNull();
  });
});
