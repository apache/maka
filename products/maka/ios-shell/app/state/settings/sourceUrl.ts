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

// Return only a verdict: never include the rejected address in diagnostics.
export function credentialFreeUrl(value: string, mode: 'skill' | 'mcp'): boolean {
  // Reject ASCII control characters (including tab/CR/LF that WHATWG URL strips before parsing).
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (mode === 'skill') {
    if (/^[^/\s]+@[^/:\s]+:/.test(value)) return false;
    if (value.startsWith('//')) return false;
    // Single-letter Windows drive path (e.g. C:\skills) without a URL scheme.
    if (/^[a-z]:[\\/]/i.test(value) && !value.includes('://')) return true;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Host directory or owner/repository shorthand when not parseable as any URL.
    return mode === 'skill' && !value.includes('://') && !/^[a-z][a-z\d+.-]+:/i.test(value);
  }
  const authority = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/\\?#]*)/i)?.[1];
  if (authority === undefined || authority.includes('@') || url.username || url.password)
    return false;
  if (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (value.split('#', 1)[0].includes('?') || !!url.search)
  )
    return false;
  return (
    mode === 'skill' || (!!url.hostname && (url.protocol === 'http:' || url.protocol === 'https:'))
  );
}
