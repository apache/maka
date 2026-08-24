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

import { isIP } from 'node:net';

export function matchesBypassList(host: string, bypassList: string[]): boolean {
  if (!host) return false;
  const lowered = host.toLowerCase();
  for (const raw of bypassList) {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === '*' || pattern === lowered) return true;
    if (pattern.startsWith('*.') && lowered.endsWith(pattern.slice(1))) return true;
    if (pattern.includes('/') && isIP(lowered) === 4 && matchesCidr(lowered, pattern)) return true;
    if (pattern.endsWith('.*') && lowered.startsWith(`${pattern.slice(0, -2)}.`)) return true;
  }
  return false;
}

function matchesCidr(ip: string, cidr: string): boolean {
  const [base, prefixRaw] = cidr.split('/');
  const prefix = Number(prefixRaw);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    result = (result << 8) | value;
  }
  return result >>> 0;
}
