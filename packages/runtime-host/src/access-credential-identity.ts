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

import { createHash } from 'node:crypto';

const CREDENTIAL_FINGERPRINT_HEX_LENGTH = 32;

export function runtimeHostAccessCredentialHash(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest();
}

export function runtimeHostAccessCredentialFingerprintFromHash(hash: string): string {
  return hash.slice(0, CREDENTIAL_FINGERPRINT_HEX_LENGTH);
}

export function runtimeHostAccessCredentialFingerprint(credential: string): string {
  return runtimeHostAccessCredentialFingerprintFromHash(
    runtimeHostAccessCredentialHash(credential).toString('hex'),
  );
}
