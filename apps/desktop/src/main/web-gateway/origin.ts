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

export function isAllowedWebOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === 'http:') {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  }
  if (url.protocol === 'https:') {
    return url.hostname === 'ts.net' || url.hostname.endsWith('.ts.net');
  }
  return false;
}

/** Origin host must equal this request's Host, ignoring default ports 80/443. */
export function originMatchesHost(origin: string, hostHeader: string | undefined): boolean {
  const fromOrigin = hostKeyFromOrigin(origin);
  const fromHost = hostKeyFromHostHeader(hostHeader);
  return fromOrigin !== undefined && fromHost !== undefined && fromOrigin === fromHost;
}

function stripDefaultPort(hostname: string, port: string): string {
  const host = hostname.toLowerCase();
  if (port === '' || port === '80' || port === '443') return host;
  return `${host}:${port}`;
}

function hostKeyFromOrigin(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    return stripDefaultPort(url.hostname, url.port);
  } catch {
    return undefined;
  }
}

function hostKeyFromHostHeader(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    const url = new URL(`http://${hostHeader}`);
    return stripDefaultPort(url.hostname, url.port);
  } catch {
    return undefined;
  }
}
