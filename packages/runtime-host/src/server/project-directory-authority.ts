import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  PROJECT_DIRECTORY_PAGE_MAX_BYTES,
  PROJECT_DIRECTORY_PAGE_MAX_ITEMS,
  PROJECT_DIRECTORY_MAX_ROOTS,
  PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES,
  type ProjectDirectoryQueryInput,
  type ProjectDirectoryQueryResult,
  type ProjectDirectoryRegisterInput,
} from '../protocol/index.js';

const HOME_ROOT_ID = 'home';
export interface PublishedProjectDirectoryRoot {
  readonly label: string;
  readonly path: string;
}

interface ResolvedProjectDirectoryRoot {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

export class HostProjectDirectoryAuthority {
  readonly #roots: readonly ResolvedProjectDirectoryRoot[];
  readonly #rootsById: ReadonlyMap<string, ResolvedProjectDirectoryRoot>;

  constructor(roots: readonly PublishedProjectDirectoryRoot[] = [{ label: '~', path: homedir() }]) {
    if (roots.length === 0 || roots.length > PROJECT_DIRECTORY_MAX_ROOTS) {
      throw new TypeError('Runtime Host must publish between one and eight project roots');
    }
    const resolved = roots.map((root, index) => resolveRoot(root, index));
    if (new Set(resolved.map((root) => root.label)).size !== resolved.length) {
      throw new TypeError('Project directory root labels must be unique');
    }
    if (new Set(resolved.map((root) => root.path)).size !== resolved.length) {
      throw new TypeError('Project directory roots must resolve to unique directories');
    }
    this.#roots = Object.freeze(resolved);
    this.#rootsById = new Map(resolved.map((root) => [root.id, root]));
  }

  async query(input: ProjectDirectoryQueryInput): Promise<ProjectDirectoryQueryResult> {
    if (input.kind === 'directory_roots') {
      return {
        kind: 'directory_roots',
        roots: this.#roots.map(({ id, label }) => ({ id, label })),
      };
    }
    const root = this.#requireRoot(input.rootId);
    const directory = await this.#resolveDirectory(root, input.segments);
    const names = await this.#listContainedDirectories(root, directory);
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
    return this.#resolveDirectory(this.#requireRoot(input.rootId), input.segments);
  }

  #requireRoot(rootId: string): ResolvedProjectDirectoryRoot {
    const root = this.#rootsById.get(rootId);
    if (!root) throw new TypeError('Unknown project directory root');
    return root;
  }

  async #resolveDirectory(
    root: ResolvedProjectDirectoryRoot,
    segments: readonly string[],
  ): Promise<string> {
    const directory = await realpath(join(root.path, ...segments));
    if (!isWithin(root.path, directory) || !(await stat(directory)).isDirectory()) {
      throw new TypeError('Project directory is outside the published root');
    }
    return directory;
  }

  async #listContainedDirectories(
    root: ResolvedProjectDirectoryRoot,
    directory: string,
  ): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        const target = await realpath(join(directory, entry.name));
        if (isWithin(root.path, target) && (await stat(target)).isDirectory()) {
          names.push(entry.name);
        }
      } catch {
        // Entries can disappear while a directory is being listed.
      }
    }
    return names.sort(compareNames);
  }
}

function resolveRoot(
  input: PublishedProjectDirectoryRoot,
  index: number,
): ResolvedProjectDirectoryRoot {
  const label = input.label.trim();
  if (
    label.length === 0 ||
    Buffer.byteLength(label, 'utf8') > PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(label)
  ) {
    throw new TypeError('Project directory root label is invalid');
  }
  const path = realpathSync(resolve(input.path));
  if (!statSync(path).isDirectory()) {
    throw new TypeError('Project directory root is not a directory');
  }
  return {
    id:
      index === 0 && input.path === homedir()
        ? HOME_ROOT_ID
        : `root-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`,
    label,
    path,
  };
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
