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

import type { BuildBuiltinToolsOptions } from './builtin-tools.js';
import {
  createBoundaryFilesystemExecutor,
  type FilesystemExecuteInput,
} from './filesystem-executor.js';
import { createLocalWorkspaceExecutor } from './workspace-executor.js';
import { ImageFileError, imageFileFailureReason } from './image-file.js';
import { FilesystemWorkerClientError } from './filesystem-worker/client.js';
import { SandboxCommandError } from './sandbox/errors.js';

type ImageFileReadFailure =
  | 'not_found'
  | 'not_allowed'
  | 'too_large'
  | 'unsupported_mime'
  | 'read_failed';
/** Normalizes filesystem backends at the image reader boundary. */
export class ImageFileReadError extends Error {
  constructor(
    readonly reason: ImageFileReadFailure,
    cause?: unknown,
  ) {
    super(cause instanceof Error ? cause.message : `Image read failed: ${reason}`, { cause });
    this.name = 'ImageFileReadError';
  }
}

function readFailure(error: unknown): ImageFileReadFailure {
  if (error instanceof ImageFileError) return imageFileFailureReason(error);
  if (error instanceof SandboxCommandError) return 'not_allowed';
  const code =
    error instanceof FilesystemWorkerClientError
      ? error.reason
      : (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'image_too_large':
      return 'too_large';
    case 'invalid_image':
      return 'unsupported_mime';
    case 'ENOENT':
    case 'ENOTDIR':
    case 'not_found':
      return 'not_found';
    case 'EACCES':
    case 'EPERM':
    case 'filesystem_denied':
    case 'path_denied':
    case 'sandbox_denied':
    case 'sandbox_required':
    case 'sandbox_boundary_required':
      return 'not_allowed';
    default:
      return 'read_failed';
  }
}
/** The same filesystem boundary as Read, without model snapshots or tool execution. */
export function createImageFileReader(
  options: Pick<
    BuildBuiltinToolsOptions,
    'executor' | 'filesystemWorker' | 'permissionProfile'
  > = {},
) {
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: options.executor ?? createLocalWorkspaceExecutor(),
    ...(options.filesystemWorker ? { worker: options.filesystemWorker } : {}),
    ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
  });
  return async (input: Omit<FilesystemExecuteInput, 'operation'> & { path: string }) => {
    const { path, ...context } = input;
    const result = await filesystem
      .execute({
        ...context,
        operation: { kind: 'read', path, imagePurpose: 'chat' },
      })
      .catch((error: unknown) => {
        throw new ImageFileReadError(readFailure(error), error);
      });
    if (result.kind !== 'read_image') throw new ImageFileReadError('unsupported_mime');
    return { bytes: result.bytes, mimeType: result.mimeType };
  };
}
