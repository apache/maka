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

export const PEER_MESH_DISPLAY_NAME_MAX_LENGTH = 80;

export function canonicalPeerMeshDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Peer Mesh display name');
  const displayName = value.trim();
  if (
    displayName.length === 0 ||
    displayName.length > PEER_MESH_DISPLAY_NAME_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(displayName)
  ) {
    throw new Error('Invalid Peer Mesh display name');
  }
  return displayName;
}
