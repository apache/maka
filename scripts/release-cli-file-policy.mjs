/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const DEVELOPMENT_DIRECTORIES = new Set([
  '.nyc_output',
  '__fixtures__',
  '__tests__',
  'coverage',
  'fixture',
  'fixtures',
  'test',
  'tests',
]);
const LOCAL_PACKAGE_PREFIX = '@maka/';
const ASF_WIP_DISCLAIMER_MARKER = '<!-- ASF-WIP-DISCLAIMER -->';

function manifestFromEntry(entry) {
  return entry?.manifest ?? entry;
}

export function renderNpmReadme(readme, disclaimer) {
  const markerCount = readme.split(ASF_WIP_DISCLAIMER_MARKER).length - 1;
  if (markerCount !== 1) {
    throw new Error(`CLI README must contain exactly one ${ASF_WIP_DISCLAIMER_MARKER} marker.`);
  }
  if (!disclaimer.trim()) throw new Error('DISCLAIMER-WIP must not be empty.');
  return readme.replace(ASF_WIP_DISCLAIMER_MARKER, disclaimer.trimEnd());
}

export function collectWorkspaceDependencyClosure(entryName, manifestsByName) {
  const closure = [];
  const complete = new Set();
  const visiting = new Set();

  function visit(packageName) {
    if (complete.has(packageName)) return;
    if (visiting.has(packageName)) {
      throw new Error(`Workspace dependency cycle reached ${packageName}.`);
    }
    const entry = manifestsByName.get(packageName);
    if (!entry) throw new Error(`Workspace package ${packageName} is missing.`);
    visiting.add(packageName);
    const manifest = manifestFromEntry(entry);
    for (const dependencyName of Object.keys(manifest.dependencies ?? {}).sort()) {
      if (manifestsByName.has(dependencyName)) visit(dependencyName);
      else if (dependencyName.startsWith(LOCAL_PACKAGE_PREFIX)) {
        throw new Error(
          `${packageName} depends on local package ${dependencyName}, but it is not in workspaces.`,
        );
      }
    }
    visiting.delete(packageName);
    complete.add(packageName);
    closure.push(packageName);
  }

  visit(entryName);
  return closure;
}

export function orderWorkspaceBuilds(workspaces) {
  const workspacesByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const order = [];
  const complete = new Set();
  const visiting = new Set();

  function visit(packageName) {
    if (complete.has(packageName)) return;
    if (visiting.has(packageName)) {
      throw new Error(`Workspace build dependency cycle reached ${packageName}.`);
    }
    const workspace = workspacesByName.get(packageName);
    if (!workspace) throw new Error(`Selected workspace package ${packageName} is missing.`);
    visiting.add(packageName);
    const manifest = manifestFromEntry(workspace);
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    for (const dependencyName of Object.keys(dependencies).sort()) {
      if (workspacesByName.has(dependencyName)) visit(dependencyName);
    }
    visiting.delete(packageName);
    complete.add(packageName);
    order.push(packageName);
  }

  for (const { name } of workspaces) visit(name);
  return order;
}

export function workspaceReleaseFiles(manifest) {
  const declared = Object.hasOwn(manifest, 'releaseFiles') ? manifest.releaseFiles : ['dist'];
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(`${manifest.name ?? 'Workspace package'} releaseFiles must be non-empty.`);
  }
  const releaseFiles = declared.map((path) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`${manifest.name ?? 'Workspace package'} releaseFiles must be paths.`);
    }
    if (
      isAbsolute(path) ||
      path.includes('\\') ||
      /[*?[\]{}]/u.test(path) ||
      path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error(`${manifest.name ?? 'Workspace package'} has unsafe release file ${path}.`);
    }
    return path;
  });
  if (new Set(releaseFiles).size !== releaseFiles.length) {
    throw new Error(`${manifest.name ?? 'Workspace package'} releaseFiles contain duplicates.`);
  }
  for (const [index, path] of releaseFiles.entries()) {
    const overlap = releaseFiles
      .slice(index + 1)
      .find((candidate) => path.startsWith(`${candidate}/`) || candidate.startsWith(`${path}/`));
    if (overlap) {
      throw new Error(
        `${manifest.name ?? 'Workspace package'} releaseFiles overlap at ${path} and ${overlap}.`,
      );
    }
  }
  if (!releaseFiles.includes('dist')) {
    throw new Error(`${manifest.name ?? 'Workspace package'} releaseFiles must include dist.`);
  }
  return releaseFiles;
}

export function resolveWorkspaceReleaseFiles(directory, manifest) {
  const releaseFiles = workspaceReleaseFiles(manifest);
  for (const releaseFile of releaseFiles) {
    const entry = lstatSync(join(directory, ...releaseFile.split('/')), { throwIfNoEntry: false });
    if (!entry) {
      throw new Error(
        `${manifest.name ?? 'Workspace package'} release file is missing: ${releaseFile}`,
      );
    }
    if (releaseFile === 'dist') {
      if (!entry.isDirectory()) {
        throw new Error(
          `${manifest.name ?? 'Workspace package'} release dist must be a directory.`,
        );
      }
    } else if (!entry.isFile()) {
      throw new Error(
        `${manifest.name ?? 'Workspace package'} release asset must be a regular file: ${releaseFile}`,
      );
    }
  }
  return releaseFiles;
}

export function resolveReleaseWorkspacePackages(repoRoot, entryName = 'maka-agent') {
  const resolvedRepoRoot = realpathSync(repoRoot);
  const rootManifest = JSON.parse(readFileSync(join(resolvedRepoRoot, 'package.json'), 'utf8'));
  const manifestsByName = new Map();
  for (const workspacePath of rootManifest.workspaces ?? []) {
    if (typeof workspacePath !== 'string' || /[*?[\]{}]/u.test(workspacePath)) {
      throw new Error(`CLI release requires explicit workspace paths, found ${workspacePath}.`);
    }
    const directory = realpathSync(resolve(resolvedRepoRoot, workspacePath));
    const pathFromRepo = relative(resolvedRepoRoot, directory);
    if (pathFromRepo === '..' || pathFromRepo.startsWith(`..${sep}`) || isAbsolute(pathFromRepo)) {
      throw new Error(`Workspace path escapes the repository: ${workspacePath}`);
    }
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (typeof manifest.name !== 'string' || !manifest.name) {
      throw new Error(`${workspacePath}/package.json is missing a package name.`);
    }
    if (manifestsByName.has(manifest.name)) {
      throw new Error(`Duplicate workspace package name ${manifest.name}.`);
    }
    manifestsByName.set(manifest.name, { directory, manifest, workspacePath });
  }
  return collectWorkspaceDependencyClosure(entryName, manifestsByName).map((name) => ({
    name,
    ...manifestsByName.get(name),
  }));
}

export function releaseNpmEnvironment(environment, userConfigPath) {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) =>
          name.toLowerCase() !== 'npm_config_allow_scripts' &&
          name.toLowerCase() !== 'npm_config_userconfig',
      ),
    ),
    npm_config_userconfig: userConfigPath,
  };
}

export function isThirdPartyDevelopmentArtifact(relativePath) {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  if (segments.some((segment) => DEVELOPMENT_DIRECTORIES.has(segment))) return true;

  const file = segments.at(-1) ?? '';
  return (
    /\.(?:spec|test)\.(?:cjs|js|mjs)$/.test(file) ||
    /\.d\.ts(?:\.map)?$/.test(file) ||
    /\.(?:cjs|js|mjs)\.map$/.test(file) ||
    /\.(?:cts|mts|ts|tsx)$/.test(file) ||
    file.endsWith('.tsbuildinfo')
  );
}

// Modules that only a test or E2E entry point may import. They are a
// Maka-owned convention, so they are not part of DEVELOPMENT_DIRECTORIES: a
// third-party package is free to ship a directory by that name.
const MAKA_TEST_ONLY_DIRECTORY = 'test-only';

export function isMakaDevelopmentArtifact(relativePath) {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  if (segments.some((segment) => segment === 'src')) return true;
  if (segments.some((segment) => segment === MAKA_TEST_ONLY_DIRECTORY)) return true;
  if (segments.some((segment) => DEVELOPMENT_DIRECTORIES.has(segment))) return true;

  const file = segments.at(-1) ?? '';
  return (
    file === 'dev-cli.js' ||
    /\.(?:spec|test)\.js$/.test(file) ||
    /\.d\.ts(?:\.map)?$/.test(file) ||
    /\.js\.map$/.test(file)
  );
}

export function isCurrentDevelopmentJavaScript(
  workspaceRoot,
  relativePath,
  generatedFiles = new Set(),
) {
  const portablePath = relativePath.split(/[\\/]/u).join('/');
  if (generatedFiles.has(portablePath)) return true;
  if (!portablePath.endsWith('.js')) return false;
  const sourcePath = portablePath.slice(0, -'.js'.length);
  return ['.ts', '.tsx', '.mts', '.cts'].some((extension) =>
    existsSync(join(workspaceRoot, 'src', `${sourcePath}${extension}`)),
  );
}
