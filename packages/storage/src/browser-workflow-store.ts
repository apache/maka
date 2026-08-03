import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isBrowserWorkflow,
  type BrowserWorkflow,
  validateBrowserWorkflow,
} from '@maka/core/browser-workflow';
import { chainWrite } from './write-queue.js';

export interface BrowserWorkflowStore {
  loadAll(): Promise<BrowserWorkflow[]>;
  get(id: string): Promise<BrowserWorkflow | undefined>;
  save(workflow: BrowserWorkflow): Promise<void>;
  remove(id: string): Promise<void>;
}

interface BrowserWorkflowFile {
  version: 1;
  workflows: BrowserWorkflow[];
}

export function createBrowserWorkflowStore(workspaceRoot: string): BrowserWorkflowStore {
  return new FileBrowserWorkflowStore(workspaceRoot);
}

class FileBrowserWorkflowStore implements BrowserWorkflowStore {
  private readonly filePath: string;
  private readonly writeQueue = new Map<string, Promise<void>>();
  private static readonly QUEUE_KEY = 'browser-workflows';

  constructor(workspaceRoot: string) {
    this.filePath = join(workspaceRoot, 'browser-workflows.json');
  }

  async loadAll(): Promise<BrowserWorkflow[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(
        `[browser-workflow-store] failed to read ${this.filePath}: ${(error as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `[browser-workflow-store] ${this.filePath} is not valid JSON: ${(error as Error).message}`,
      );
    }
    if (!isBrowserWorkflowFile(parsed)) {
      throw new Error(
        `[browser-workflow-store] ${this.filePath} has an unrecognized shape or version`,
      );
    }
    return parsed.workflows.map((workflow) => validateBrowserWorkflow(workflow));
  }

  async get(id: string): Promise<BrowserWorkflow | undefined> {
    return (await this.loadAll()).find((workflow) => workflow.id === id);
  }

  async save(workflow: BrowserWorkflow): Promise<void> {
    validateBrowserWorkflow(workflow);
    await chainWrite(this.writeQueue, FileBrowserWorkflowStore.QUEUE_KEY, async () => {
      const current = await this.loadAll();
      const index = current.findIndex((entry) => entry.id === workflow.id);
      if (index >= 0) current[index] = workflow;
      else current.push(workflow);
      await this.writeFile(current);
    });
  }

  async remove(id: string): Promise<void> {
    await chainWrite(this.writeQueue, FileBrowserWorkflowStore.QUEUE_KEY, async () => {
      const current = await this.loadAll();
      const filtered = current.filter((workflow) => workflow.id !== id);
      if (filtered.length !== current.length) await this.writeFile(filtered);
    });
  }

  private async writeFile(workflows: BrowserWorkflow[]): Promise<void> {
    const data: BrowserWorkflowFile = { version: 1, workflows };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await rename(tempPath, this.filePath);
  }
}

function isBrowserWorkflowFile(value: unknown): value is BrowserWorkflowFile {
  if (typeof value !== 'object' || value === null) return false;
  const object = value as Record<string, unknown>;
  return (
    object.version === 1 &&
    Array.isArray(object.workflows) &&
    object.workflows.every(isBrowserWorkflow)
  );
}
