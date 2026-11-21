import { createEventLog } from "./events";
import { createJobPipeline } from "./jobs";
import { createSeamRegistry } from "./seams";

export type ToolkitOptions = {
  dbPath: string;
};

export function createToolkit(options: ToolkitOptions) {
  const events = createEventLog(options.dbPath);
  const jobs = createJobPipeline(events);
  const seams = createSeamRegistry();
  return { events, jobs, seams };
}

export type Toolkit = ReturnType<typeof createToolkit>;
