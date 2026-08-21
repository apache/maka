import { realpathSync, statSync } from 'node:fs';
import { opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  PROJECT_DIRECTORY_MAX_ENTRIES,
  PROJECT_DIRECTORY_PAGE_MAX_BYTES,
  PROJECT_DIRECTORY_PAGE_MAX_ITEMS,
  PROJECT_DIRECTORY_MAX_ROOTS,
  PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES,
  type ProjectDirectoryQueryInput,
  type ProjectDirectoryQueryResult,
  type ProjectDirectoryRegisterInput,
} from '../protocol/index.js';

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

  constructor(roots?: readonly PublishedProjectDirectoryRoot[]) {
    if (roots && roots.length > PROJECT_DIRECTORY_MAX_ROOTS) {
      throw new TypeError('Runtime Host may publish at most eight project roots');
    }
    const resolved =
      roots === undefined
        ? resolveImplicitHomeRoot()
        : roots.map((root, index) => resolveRoot(root, index));
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
    if (!isWithin(root.path, directory)) {
      throw new TypeError('Project directory is outside the published root');
    }
    if (!(await stat(directory)).isDirectory()) {
      throw new TypeError('Project directory is not a directory');
    }
    return directory;
  }

  async #listContainedDirectoryPage(
    root: ResolvedProjectDirectoryRoot,
    directory: string,
    input: Exclude<ProjectDirectoryQueryInput, { readonly kind: 'directory_roots' }>,
  ): Promise<ProjectDirectoryQueryResult> {
    const names = await boundedDirectoryNames(directory);
    const start = input.kind === 'directory_list_start' ? 0 : firstNameAfter(names, input.cursor);
    const entries: { name: string }[] = [];
    for (let index = start; index < names.length; index += 1) {
      const name = names[index];
      if (!name) continue;
      let contained = false;
      try {
        const target = await realpath(join(directory, name));
        contained = isWithin(root.path, target) && (await stat(target)).isDirectory();
      } catch {
        // Entries can disappear while a directory is being listed.
      }
      if (!contained) continue;
      const page = directoryPage(input, [...entries, { name }], name);
      if (
        entries.length >= PROJECT_DIRECTORY_PAGE_MAX_ITEMS ||
        Buffer.byteLength(JSON.stringify(page), 'utf8') > PROJECT_DIRECTORY_PAGE_MAX_BYTES
      ) {
        if (entries.length === 0) {
          throw new TypeError('Project directory entry exceeds the response limit');
        }
        return directoryPage(input, entries, entries.at(-1)?.name ?? null);
      }
      entries.push({ name });
      if (entries.length >= PROJECT_DIRECTORY_PAGE_MAX_ITEMS) {
        return directoryPage(input, entries, index + 1 < names.length ? name : null);
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
    id: `root-${index + 1}`,
    label,
    path,
  };
}

function resolveImplicitHomeRoot(): readonly ResolvedProjectDirectoryRoot[] {
  try {
    return [resolveRoot({ label: '~', path: homedir() }, 0)];
  } catch {
    // Directory browsing is optional; an unusable service-account Home must
    // not prevent unrelated Runtime Host domains from starting.
    return [];
  }
}

async function boundedDirectoryNames(directory: string): Promise<string[]> {
  const names: string[] = [];
  let scanned = 0;
  for await (const entry of await opendir(directory)) {
    scanned += 1;
    if (scanned > PROJECT_DIRECTORY_MAX_ENTRIES) {
      throw new TypeError('Project directory contains too many entries');
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) names.push(entry.name);
  }
  return names.sort(compareNames);
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
