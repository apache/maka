import { describe, expect, it } from "vitest";

import { createEventLog } from "./events";
import { createJobPipeline } from "./jobs";

describe("job pipeline", () => {
  it("runs pre-execute, execute, then post-execute in order", async () => {
    const phases: string[] = [];
    const pipeline = createJobPipeline(createEventLog(":memory:"));
    pipeline.use("pre-execute", async () => {
      phases.push("pre");
    });
    pipeline.register({
      name: "echo",
      execute: async (input) => {
        phases.push("execute");
        return input;
      },
    });
    pipeline.use("post-execute", async () => {
      phases.push("post");
    });

    const result = await pipeline.run("echo", { value: 1 });
    expect(result).toEqual({ ok: true, result: { value: 1 } });
    expect(phases).toEqual(["pre", "execute", "post"]);
  });

  it("skips execute when a pre-execute hook aborts", async () => {
    const phases: string[] = [];
    const pipeline = createJobPipeline(createEventLog(":memory:"));
    pipeline.use("pre-execute", async () => {
      phases.push("pre");
      return { abort: true, reason: "blocked" };
    });
    pipeline.register({
      name: "echo",
      execute: async () => {
        phases.push("execute");
        return "nope";
      },
    });
    pipeline.use("post-execute", async () => {
      phases.push("post");
    });

    const result = await pipeline.run("echo", {});
    expect(result).toEqual({ ok: false, error: "blocked" });
    expect(phases).toEqual(["pre"]);
  });

  it("appends job.ran after a successful execute", async () => {
    const events = createEventLog(":memory:");
    const pipeline = createJobPipeline(events);
    pipeline.register({
      name: "echo",
      execute: () => "ok",
    });
    await pipeline.run("echo", {});
    expect(events.list().map((event) => event.type)).toEqual(["job.ran"]);
    expect(events.list()[0]?.payload).toEqual({ name: "echo" });
  });

  it("appends job.aborted when a pre-execute hook blocks", async () => {
    const events = createEventLog(":memory:");
    const pipeline = createJobPipeline(events);
    pipeline.use("pre-execute", () => ({ abort: true, reason: "blocked" }));
    pipeline.register({
      name: "echo",
      execute: () => "ok",
    });
    await pipeline.run("echo", {});
    expect(events.list().map((event) => event.type)).toEqual(["job.aborted"]);
  });

  it("appends job.failed for unknown tools", async () => {
    const events = createEventLog(":memory:");
    const pipeline = createJobPipeline(events);
    await pipeline.run("missing", {});
    expect(events.list().map((event) => event.type)).toEqual(["job.failed"]);
  });
});

