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

const ACTIONABLE_AX_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

const NAMED_SCOPE_ROLES = new Set([
  'alert',
  'alertdialog',
  'article',
  'dialog',
  'form',
  'group',
  'list',
  'listitem',
  'main',
  'navigation',
  'region',
  'row',
  'status',
  'tablist',
  'toolbar',
]);

function axValue(value) {
  return value?.value;
}

export function axString(value) {
  const raw = axValue(value);
  return typeof raw === 'string' ? raw.trim() : '';
}

function properties(node) {
  return new Map(
    (node.properties ?? []).map((property) => [property.name, axValue(property.value)]),
  );
}

function exposedNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : []).filter((node) => !node?.ignored);
}

function applicationNodes(nodes) {
  return exposedNodes(nodes).filter(
    (node) => !['RootWebArea', 'WebArea'].includes(axString(node.role)),
  );
}

function actionableNodes(nodes) {
  return exposedNodes(nodes).filter((node) => ACTIONABLE_AX_ROLES.has(axString(node.role)));
}

function subtreeText(node, nodesById, cache) {
  const cached = cache.get(node.nodeId);
  if (cached !== undefined) return cached;
  const names = [];
  const queue = [...(node.childIds ?? [])];
  let index = 0;
  while (index < queue.length && names.length < 3) {
    const child = nodesById.get(queue[index]);
    index += 1;
    if (!child) continue;
    const role = axString(child.role);
    const name = axString(child.name);
    if (name && !ACTIONABLE_AX_ROLES.has(role)) names.push(name);
    queue.push(...(child.childIds ?? []));
  }
  const text = names.join(' · ');
  cache.set(node.nodeId, text);
  return text;
}

function namedScope(node, nodesById, subtreeTextCache) {
  const scopes = [];
  let parentId = node.parentId;
  while (parentId && scopes.length < 3) {
    const parent = nodesById.get(parentId);
    if (!parent) break;
    const role = axString(parent.role);
    if (NAMED_SCOPE_ROLES.has(role)) {
      const name = axString(parent.name) || subtreeText(parent, nodesById, subtreeTextCache);
      if (name) scopes.push(`${role}:${name}`);
    }
    parentId = parent.parentId;
  }
  const key = scopes.join(' > ');
  return {
    key,
    label: key.length > 160 ? `${key.slice(0, 159)}…` : key,
  };
}

export function findUnnamedActionableAxNodes(nodes) {
  return actionableNodes(nodes)
    .filter((node) => !axString(node.name))
    .map((node) => ({
      role: axString(node.role),
      backendDOMNodeId: node.backendDOMNodeId,
    }));
}

export function findAxLandmarkProblems(nodes) {
  const mainLandmarks = exposedNodes(nodes).filter((node) => axString(node.role) === 'main');
  return mainLandmarks.length > 1
    ? [
        {
          code: 'multiple_main_landmarks',
          nodes: mainLandmarks.map((node) => ({
            name: axString(node.name),
            backendDOMNodeId: node.backendDOMNodeId,
          })),
        },
      ]
    : [];
}

export function findMissingActionableState(nodes) {
  const missing = [];
  for (const node of actionableNodes(nodes)) {
    const role = axString(node.role);
    const state = properties(node);
    if (
      ['checkbox', 'menuitemcheckbox', 'menuitemradio', 'radio', 'switch'].includes(role) &&
      !state.has('checked')
    ) {
      missing.push({ role, name: axString(node.name), property: 'checked' });
    }
    if (['option', 'tab'].includes(role) && !state.has('selected')) {
      missing.push({ role, name: axString(node.name), property: 'selected' });
    }
    if (
      (role === 'combobox' || (role === 'button' && state.has('controls'))) &&
      !state.has('expanded')
    ) {
      missing.push({ role, name: axString(node.name), property: 'expanded' });
    }
    if (['slider', 'spinbutton'].includes(role) && axValue(node.value) === undefined) {
      missing.push({ role, name: axString(node.name), property: 'value' });
    }
  }
  return missing;
}

export function findUnnamedRequiredContainers(nodes) {
  return exposedNodes(nodes)
    .filter((node) => ['alertdialog', 'dialog'].includes(axString(node.role)))
    .filter((node) => !axString(node.name))
    .map((node) => ({
      role: axString(node.role),
      backendDOMNodeId: node.backendDOMNodeId,
    }));
}

export function findAmbiguousActionableAxNodes(nodes) {
  const exposed = exposedNodes(nodes);
  const nodesById = new Map(
    (Array.isArray(nodes) ? nodes : [])
      .filter((node) => typeof node.nodeId === 'string')
      .map((node) => [node.nodeId, node]),
  );
  const subtreeTextCache = new Map();
  const grouped = new Map();
  for (const node of actionableNodes(exposed)) {
    const role = axString(node.role);
    const name = axString(node.name);
    if (!name) continue;
    const key = `${role}\u0000${name}`;
    const entries = grouped.get(key) ?? [];
    const scope = namedScope(node, nodesById, subtreeTextCache);
    entries.push({
      role,
      name,
      scope: scope.label,
      scopeKey: scope.key,
      backendDOMNodeId: node.backendDOMNodeId,
    });
    grouped.set(key, entries);
  }

  const ambiguous = [];
  for (const entries of grouped.values()) {
    if (entries.length < 2) continue;
    const byScope = new Map();
    for (const entry of entries) {
      const scoped = byScope.get(entry.scopeKey) ?? [];
      scoped.push(entry);
      byScope.set(entry.scopeKey, scoped);
    }
    for (const scoped of byScope.values()) {
      if (scoped.length < 2) continue;
      ambiguous.push({
        role: scoped[0].role,
        name: scoped[0].name,
        scope: scoped[0].scope,
        count: scoped.length,
        backendDOMNodeIds: scoped.map((entry) => entry.backendDOMNodeId),
      });
    }
  }
  return ambiguous;
}

export function auditAxTree(nodes) {
  const sourceNodes = Array.isArray(nodes) ? nodes : [];
  const exposed = exposedNodes(sourceNodes);
  const application = applicationNodes(sourceNodes);
  const problems = [];
  if (application.length === 0) problems.push({ code: 'empty_ax_tree', nodes: [] });

  const unnamed = findUnnamedActionableAxNodes(sourceNodes);
  if (unnamed.length > 0) problems.push({ code: 'unnamed_actionable', nodes: unnamed });

  problems.push(...findAxLandmarkProblems(sourceNodes));

  const missingState = findMissingActionableState(sourceNodes);
  if (missingState.length > 0) {
    problems.push({ code: 'missing_actionable_state', nodes: missingState });
  }

  const ambiguous = findAmbiguousActionableAxNodes(sourceNodes);
  if (ambiguous.length > 0) {
    problems.push({ code: 'ambiguous_actionable', nodes: ambiguous });
  }

  const unnamedContainers = findUnnamedRequiredContainers(sourceNodes);
  if (unnamedContainers.length > 0) {
    problems.push({ code: 'unnamed_required_container', nodes: unnamedContainers });
  }

  return {
    sourceNodeCount: sourceNodes.length,
    exposedNodeCount: exposed.length,
    applicationNodeCount: application.length,
    actionableNodeCount: actionableNodes(sourceNodes).length,
    problems,
  };
}
