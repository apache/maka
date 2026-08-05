import assert from "node:assert/strict";
import test from "node:test";
import { createAppShellPlanActions } from "../../renderer/app-shell-plan-actions.js";

test("localizes the incognito reminder error at the renderer boundary", async () => {
  const originalWindow = globalThis.window;
  const messages: Array<{ title: string; description?: string }> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      maka: {
        plans: {
          create: async () => {
            throw new Error(
              "Error invoking remote method 'plans:create': PLAN_REMINDER_INCOGNITO_ACTIVE",
            );
          },
        },
      },
    },
  });

  try {
    const actions = createAppShellPlanActions({
      uiLocale: "zh",
      getPlanReminders: () => [],
      isAutomationsSurfaceActive: () => true,
      setPlanReminders: () => undefined,
      toastApi: {
        success: () => undefined,
        error: (title, description) => messages.push({ title, description }),
        confirm: async () => true,
      },
    });

    assert.equal(
      await actions.createPlanReminder({
        title: "Review",
        runAt: Date.now() + 60_000,
      }),
      false,
    );
    assert.deepEqual(messages, [
      {
        title: "创建计划失败",
        description: "隐身模式开启时不能创建计划提醒。",
      },
    ]);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});
