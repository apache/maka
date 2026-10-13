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

import {
  classifyGeneralizedError,
  redactSecrets,
  type GeneralizedErrorClass,
} from './redaction.js';

export type AppUpdateErrorClass =
  | GeneralizedErrorClass
  | 'release_unavailable'
  | 'metadata_unavailable';

/** Keep transport evidence, but exclude release notes and generic 404 credential advice. */
export function appUpdateErrorSummary(error: unknown): { message: string; errorCode?: string } {
  const raw =
    typeof error === 'string'
      ? error
      : error &&
          typeof error === 'object' &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : String(error);
  const errorCode =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error &&
          typeof error === 'object' &&
          'errorCode' in error &&
          typeof error.errorCode === 'string'
        ? error.errorCode
        : undefined;
  // Wrapped updater errors embed stacks inside message. File names, line
  // numbers and dependency paths are not evidence of an HTTP failure.
  let message = raw.replace(/^\s+at[^\S\r\n]+[^\r\n]*(?:\r?\n|$)/gm, '');
  if (raw.startsWith('Cannot parse releases feed:')) {
    message = message.split(/,?\r?\nXML:\r?\n/, 1)[0] ?? message;
  }
  if (
    errorCode === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
    message.includes('Cannot find ') ||
    message.includes('Unable to find latest version on GitHub')
  ) {
    message = message.replace(
      /Please double check that your authentication token is correct\.[^\r\n]*/g,
      '',
    );
  }
  return { message: redactSecrets(message).trim(), ...(errorCode ? { errorCode } : {}) };
}

export function classifyAppUpdateError(error: unknown): AppUpdateErrorClass | undefined {
  const { message, errorCode } = appUpdateErrorSummary(error);
  if (
    errorCode === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
    message === 'No published versions on GitHub'
  ) {
    return 'release_unavailable';
  }
  // Preserve actual transport failures even when the updater wraps them as a feed failure.
  const classified = classifyGeneralizedError(new Error(message));
  if (classified) return classified;
  if (
    errorCode === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
    message.includes('Unable to find latest version on GitHub')
  ) {
    return 'release_unavailable';
  }
  if (
    errorCode === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
    errorCode === 'ERR_UPDATER_INVALID_RELEASE_FEED' ||
    errorCode === 'ERR_UPDATER_INVALID_UPDATE_INFO' ||
    message.startsWith('Cannot parse releases feed:')
  ) {
    return 'metadata_unavailable';
  }
  return undefined;
}
