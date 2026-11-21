import type { EventLog } from "./events";

export type JobPhase = "pre-execute" | "post-execute";

export type JobHookResult = void | { abort: true; reason: string };

export type JobTool = {
  name: string;
  execute: (input: unknown) => Promise<unknown> | unknown;
};

export type JobRunResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export type JobPipeline = {
  use: (phase: JobPhase, hook: (input: unknown) => Promise<JobHookResult> | JobHookResult) => void;
  register: (tool: JobTool) => void;
  run: (name: string, input: unknown) => Promise<JobRunResult>;
  list: () => string[];
};

export function createJobPipeline(events: EventLog): JobPipeline {
  const tools = new Map<string, JobTool>();
  const hooks: Record<JobPhase, Array<(input: unknown) => Promise<JobHookResult> | JobHookResult>> = {
    "pre-execute": [],
    "post-execute": [],
  };

  return {
    use(phase, hook) {
      hooks[phase].push(hook);
    },
    register(tool) {
      tools.set(tool.name, tool);
    },
    list() {
      return [...tools.keys()];
    },
    async run(name, input) {
      const tool = tools.get(name);
      if (!tool) {
        events.append({
          type: "job.failed",
          payload: { name, error: `unknown tool: ${name}` },
        });
        return { ok: false, error: `unknown tool: ${name}` };
      }

      for (const hook of hooks["pre-execute"]) {
        const result = await hook(input);
        if (result && result.abort) {
          events.append({
            type: "job.aborted",
            payload: { name, reason: result.reason },
          });
          return { ok: false, error: result.reason };
        }
      }

      const value = await tool.execute(input);

      for (const hook of hooks["post-execute"]) {
        await hook(input);
      }

      events.append({ type: "job.ran", payload: { name } });
      return { ok: true, result: value };
    },
  };
}
