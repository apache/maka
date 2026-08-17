import { homedir } from 'node:os';
import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  PROJECT_DIRECTORY_PAGE_MAX_BYTES,
  PROJECT_DIRECTORY_PAGE_MAX_ITEMS,
  type ProjectDirectoryQueryInput,
  type ProjectDirectoryQueryResult,
  type ProjectDirectoryRegisterInput,
} from '../protocol/index.js';

const HOME_ROOT_ID = 'home';

export class HostProjectDirectoryAuthority {
  readonly #homeDirectory: string;

  constructor(homeDirectory = homedir()) {
    this.#homeDirectory = resolve(homeDirectory);
  }

  async query(input: ProjectDirectoryQueryInput): Promise<ProjectDirectoryQueryResult> {
    if (input.kind === 'directory_roots') {
      return { kind: 'directory_roots', roots: [{ id: HOME_ROOT_ID }] };
    }
    const directory = await this.#resolveDirectory(input);
    const names = await this.#listContainedDirectories(directory);
    const start = input.kind === 'directory_list_start' ? 0 : firstNameAfter(names, input.cursor);
    const entries: { name: string }[] = [];
    for (let index = start; index < names.length; index += 1) {
      const name = names[index];
      if (!name) continue;
      const candidate: ProjectDirectoryQueryResult = {
        kind: 'directory_page',
        rootId: input.rootId,
        segments: input.segments,
        entries: [...entries, { name }],
        nextCursor: index + 1 < names.length ? name : null,
      };
      if (
        entries.length >= PROJECT_DIRECTORY_PAGE_MAX_ITEMS ||
        Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PROJECT_DIRECTORY_PAGE_MAX_BYTES
      ) {
        break;
      }
      entries.push({ name });
    }
    if (entries.length === 0 && start < names.length) {
      throw new TypeError('Project directory entry exceeds the response limit');
    }
    const nextIndex = start + entries.length;
    return {
      kind: 'directory_page',
      rootId: input.rootId,
      segments: input.segments,
      entries,
      nextCursor: nextIndex < names.length ? (entries.at(-1)?.name ?? null) : null,
    };
  }

  resolveRegistration(input: ProjectDirectoryRegisterInput): Promise<string> {
    return this.#resolveDirectory(input);
  }

  async #resolveDirectory(input: {
    readonly rootId: string;
    readonly segments: readonly string[];
  }): Promise<string> {
    if (input.rootId !== HOME_ROOT_ID) throw new TypeError('Unknown project directory root');
    const root = await realpath(this.#homeDirectory);
    const directory = await realpath(join(root, ...input.segments));
    if (!isWithin(root, directory) || !(await stat(directory)).isDirectory()) {
      throw new TypeError('Project directory is outside the published root');
    }
    return directory;
  }

  async #listContainedDirectories(directory: string): Promise<string[]> {
    const root = await realpath(this.#homeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        const target = await realpath(join(directory, entry.name));
        if (isWithin(root, target) && (await stat(target)).isDirectory()) names.push(entry.name);
      } catch {
        // Entries can disappear while a directory is being listed.
      }
    }
    return names.sort(compareNames);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function firstNameAfter(names: readonly string[], cursor: string): number {
  const index = names.findIndex((name) => compareNames(name, cursor) > 0);
  return index < 0 ? names.length : index;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
