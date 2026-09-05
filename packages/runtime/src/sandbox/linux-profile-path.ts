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

import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';

export interface PinnedLinuxProfilePath {
  readonly path: string;
  readonly access: 'read' | 'write';
  readonly sourceFd: number;
  readonly releaseSource: () => void;
  readonly childFd: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export function pinExistingLinuxProfilePath(input: {
  path: string;
  access: 'read' | 'write';
  targetType: 'file' | 'directory' | 'other';
  childFd: number;
}): PinnedLinuxProfilePath | undefined {
  const existing = (() => {
    try {
      return lstatSync(input.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  })();
  if (!existing) return undefined;
  if (existing.isSymbolicLink() || !matchesTargetType(existing, input.targetType)) {
    throw new Error(`Approved sandbox path changed type: ${input.path}`);
  }

  const linuxConstants = constants as typeof constants & { O_PATH?: number };
  const sourceFd = openSync(
    input.path,
    (linuxConstants.O_PATH ?? constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0),
  );
  let sourceOpen = true;
  const releaseSource = () => {
    if (!sourceOpen) return;
    sourceOpen = false;
    closeSync(sourceFd);
  };
  try {
    const metadata = fstatSync(sourceFd, { bigint: true });
    if (
      metadata.dev !== BigInt(existing.dev) ||
      metadata.ino !== BigInt(existing.ino) ||
      !matchesTargetType(metadata, input.targetType)
    ) {
      throw new Error(`Approved sandbox path changed while pinning: ${input.path}`);
    }
    return {
      path: input.path,
      access: input.access,
      sourceFd,
      releaseSource,
      childFd: input.childFd,
      device: metadata.dev,
      inode: metadata.ino,
      mtimeNs: metadata.mtimeNs,
      ctimeNs: metadata.ctimeNs,
    };
  } catch (error) {
    releaseSource();
    throw error;
  }
}

function matchesTargetType(
  metadata: {
    isFile(): boolean;
    isDirectory(): boolean;
  },
  targetType: 'file' | 'directory' | 'other',
): boolean {
  if (targetType === 'file') return metadata.isFile();
  if (targetType === 'directory') return metadata.isDirectory();
  return !metadata.isFile() && !metadata.isDirectory();
}
