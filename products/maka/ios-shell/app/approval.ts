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

import { copy } from './copy';

function exactObject(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  return Object.keys(object).length === keys.length &&
    keys.every((key) => Object.hasOwn(object, key))
    ? object
    : null;
}

// Only grant shapes understood and shown here can be approved on this device.
export function describePermissions(value: unknown): string | null {
  const grants = exactObject(value, ['filesystem', 'network']);
  if (!grants || !Array.isArray(grants.filesystem)) return null;
  const lines: string[] = [];
  for (const item of grants.filesystem) {
    const rule = exactObject(item, ['path', 'scope', 'access']);
    if (
      !rule ||
      typeof rule.path !== 'string' ||
      !rule.path ||
      (rule.scope !== 'exact' && rule.scope !== 'subtree') ||
      (rule.access !== 'read' && rule.access !== 'write')
    )
      return null;
    lines.push(
      `${rule.access === 'write' ? copy('Read and write', '读写', '讀寫') : copy('Read only', '只读', '唯讀')} · ${rule.scope === 'subtree' ? copy('Directory and descendants', '目录及其子项', '目錄及其子項') : copy('Exact path', '指定路径', '指定路徑')}: ${JSON.stringify(rule.path)}`,
    );
  }
  if (!lines.length)
    lines.push(copy('No additional filesystem access', '无额外文件权限', '無額外檔案權限'));
  if (grants.network === 'allowed')
    lines.push(copy('Network: all destinations', '网络：所有目标', '網路：所有目標'));
  else if (grants.network === 'denied')
    lines.push(copy('Network: no access', '网络：无访问权限', '網路：無存取權限'));
  else {
    const network = exactObject(grants.network, ['restricted']);
    const restricted = exactObject(network?.restricted, ['destinations']);
    if (!restricted || !Array.isArray(restricted.destinations)) return null;
    if (!restricted.destinations.length)
      lines.push(copy('Network: no destinations', '网络：无目标', '網路：無目標'));
    for (const item of restricted.destinations) {
      const target = exactObject(item, ['host', 'port']);
      if (
        !target ||
        typeof target.host !== 'string' ||
        !target.host ||
        typeof target.port !== 'number' ||
        !Number.isInteger(target.port) ||
        target.port < 1 ||
        target.port > 65535
      )
        return null;
      lines.push(
        copy(
          `Network: exact host ${JSON.stringify(target.host)}, port ${target.port}`,
          `网络：指定主机 ${JSON.stringify(target.host)}，端口 ${target.port}`,
          `網路：指定主機 ${JSON.stringify(target.host)}，連接埠 ${target.port}`,
        ),
      );
    }
  }
  return lines.join('\n');
}

function scopeLabel(scope: 'once' | 'run' | 'session' | 'always'): string {
  switch (scope) {
    case 'once':
      return copy('once', '本次', '這次');
    case 'run':
      return copy('this turn', '本轮', '這個輪次');
    case 'session':
      return copy('this conversation', '本会话', '這段對話');
    case 'always':
      return copy('always', '始终', '一律');
  }
}

export function describeChildDecision(value: unknown): string | null {
  const answer = exactObject(value, ['kind', 'decision']);
  if (!answer) return null;
  if (answer.kind === 'permissions') {
    const decision = exactObject(answer.decision, ['decision', 'permissions', 'scope']);
    if (!decision || decision.decision !== 'allow') return null;
    const scope = decision.scope;
    if (scope !== 'once' && scope !== 'run' && scope !== 'session') return null;
    const detail = describePermissions(decision.permissions);
    return detail === null
      ? null
      : `${copy('Allow additional permissions · scope:', '允许额外权限 · 范围：', '允許額外權限 · 範圍：')} ${scopeLabel(scope)}\n${detail}`;
  }
  if (
    answer.kind === 'computer_app' &&
    (answer.decision === 'once' || answer.decision === 'session' || answer.decision === 'always')
  )
    return `${copy('Allow control of the desktop application · scope:', '允许控制桌面应用 · 范围：', '允許控制桌面應用程式 · 範圍：')} ${scopeLabel(answer.decision)}`;
  if (answer.decision !== 'allow') return null;
  if (answer.kind === 'service_approval')
    return copy('Allow this service call only', '仅允许本次服务调用', '僅允許這次服務呼叫');
  if (answer.kind === 'client_capability')
    return copy(
      'Allow the requested client capability for this interaction',
      '允许本次交互使用请求的客户端能力',
      '允許這次互動使用要求的用戶端功能',
    );
  return null;
}
