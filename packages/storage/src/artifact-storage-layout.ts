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

const UUID_V4_FRAGMENT = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';

export const ARTIFACT_PURGE_INTENT_FILE = '.artifact-purge-intent.json';
export const ARTIFACT_WRITER_LOCK_FILE = '.maka-artifact-writer.lock';

export const ARTIFACT_PURGE_INTENT_TEMP_PATTERN = new RegExp(
  `^\\.artifact-purge-intent\\.json\\.[0-9]+\\.${UUID_V4_FRAGMENT}\\.tmp$`,
);

export const ARTIFACT_PUBLICATION_STAGING_PATTERN = new RegExp(
  `^\\.artifact-publish\\.([a-f0-9]{64})\\.${UUID_V4_FRAGMENT}\\.tmp$`,
);

export function isArtifactPurgeRecoveryTempName(name: string): boolean {
  return ARTIFACT_PURGE_INTENT_TEMP_PATTERN.test(name);
}
