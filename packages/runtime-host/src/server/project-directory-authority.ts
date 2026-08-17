import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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

export interface ResolvedProjectDirectoryRegistration {
  readonly path: string;
  readonly rootPath: string;
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
    return this.#listContainedDirectoryPage(root, directory, input);
  }

  async resolveRegistration(
    input: ProjectDirectoryRegisterInput,
  ): Promise<ResolvedProjectDirectoryRegistration> {
    const root = this.#requireRoot(input.rootId);
    return {
      path: await this.#resolveDirectory(root, input.segments),
      rootPath: root.path,
    };
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

  async #listContainedDirectoryPage(
    root: ResolvedProjectDirectoryRoot,
    directory: string,
    input: Exclude<ProjectDirectoryQueryInput, { readonly kind: 'directory_roots' }>,
  ): Promise<ProjectDirectoryQueryResult> {
    const candidates = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => compareNames(left.name, right.name));
    const names = candidates.map((entry) => entry.name);
    const start = input.kind === 'directory_list_start' ? 0 : firstNameAfter(names, input.cursor);
    const entries: { name: string }[] = [];
    let lastScanned: string | undefined;
    for (let index = start; index < candidates.length; index += 1) {
      const entry = candidates[index];
      if (!entry) continue;
      let contained = false;
      try {
        const target = await realpath(join(directory, entry.name));
        contained = isWithin(root.path, target) && (await stat(target)).isDirectory();
      } catch {
        // Entries can disappear while a directory is being listed.
      }
      if (!contained) {
        lastScanned = entry.name;
        continue;
      }
      const page = directoryPage(input, [...entries, { name: entry.name }], entry.name);
      if (
        entries.length >= PROJECT_DIRECTORY_PAGE_MAX_ITEMS ||
        Buffer.byteLength(JSON.stringify(page), 'utf8') > PROJECT_DIRECTORY_PAGE_MAX_BYTES
      ) {
        if (entries.length === 0) {
          throw new TypeError('Project directory entry exceeds the response limit');
        }
        return directoryPage(input, entries, lastScanned ?? null);
      }
      entries.push({ name: entry.name });
      lastScanned = entry.name;
      if (entries.length >= PROJECT_DIRECTORY_PAGE_MAX_ITEMS) {
        return directoryPage(input, entries, index + 1 < candidates.length ? entry.name : null);
      }
    }
    return directoryPage(input, entries, null);
  }
}

function directoryPage(
  input: Exclude<ProjectDirectoryQueryInput, { readonly kind: 'directory_roots' }>,
  entries: readonly { readonly name: string }[],
  nextCursor: string | null,
): ProjectDirectoryQueryResult {
  return {
    kind: 'directory_page',
    rootId: input.rootId,
    segments: input.segments,
    entries,
    nextCursor,
  };
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
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function firstNameAfter(names: readonly string[], cursor: string): number {
  const index = names.findIndex((name) => compareNames(name, cursor) > 0);
  return index < 0 ? names.length : index;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
