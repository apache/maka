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

import { localizedPresentation, tr, type MessageKey } from './locale';
import type { ActivityPresentation } from './toolActivityPresentation';
import { record, type ToolSection } from './toolCards';

const packageName = (value: unknown) => {
  const id = record(value)?.id;
  return typeof id === 'string' ? id : null;
};
const pathName = (value: unknown) =>
  Array.isArray(value) && value.every((part) => typeof part === 'string')
    ? value.join(' / ')
    : null;
const nonempty = (value: string | null): value is string => !!value;

function list(label: string, rows: readonly string[], empty: string, hasMore = false): ToolSection {
  const visible = rows.slice(0, 8);
  if (rows.length > visible.length)
    visible.push(tr('{count} more', { count: rows.length - visible.length }));
  if (hasMore) visible.push(tr('More pages available'));
  return { label, text: visible.join('\n') || empty };
}

function displayName(value: unknown): string | null {
  const presentation = record(value);
  if (
    !presentation ||
    typeof presentation.displayName !== 'string' ||
    typeof presentation.description !== 'string'
  )
    return null;
  return (
    localizedPresentation(presentation as Parameters<typeof localizedPresentation>[0])
      .displayName || null
  );
}

function deploymentContents(input: unknown, packages: unknown, packageLabel: string) {
  if (!Array.isArray(packages)) return null;
  const configuration = record(input);
  const nodes = record(configuration?.instances);
  const base = packageName(record(configuration?.base)?.package);
  const roots = Object.keys(nodes ?? {});
  const sections: ToolSection[] = [];
  if (base) sections.push({ label: tr('Base composition'), text: base });
  if (roots.length) sections.push(list(tr('Root plugins'), roots, ''));
  sections.push(
    list(packageLabel, packages.map(packageName).filter(nonempty), tr('No packages available')),
  );
  return sections;
}

function deployments(value: unknown): ToolSection[] | null {
  const deployment = record(value);
  return deploymentContents(
    record(deployment?.source)?.input,
    deployment?.packages,
    tr('Available packages'),
  );
}

function instances(value: unknown, ui: boolean): ToolSection[] | null {
  const page = record(value);
  if (!page || !Array.isArray(page.instances)) return null;
  const rows = page.instances.flatMap((candidate) => {
    const instance = record(candidate);
    if (!instance) return [];
    const path = pathName(instance.path);
    const title = displayName(instance.presentation) || path || packageName(instance.package);
    if (!title) return [];
    const location = path && path !== title ? path : null;
    const status = ui
      ? null
      : instance.parentDisabled
        ? tr('Parent disabled')
        : instance.disabled
          ? tr('Disabled')
          : tr('Enabled');
    return [[title, location, status].filter(nonempty).join(' · ')];
  });
  const sections = [
    list(
      ui ? tr('Interface plugins') : tr('Plugin instances'),
      rows,
      ui ? tr('No interface plugins') : tr('No plugin instances on this page'),
      page.next != null,
    ),
  ];
  const selection = record(page.ui);
  if (ui && Array.isArray(selection?.instance)) {
    const selectedPath = pathName(selection.instance);
    const selected = page.instances.find(
      (candidate) => pathName(record(candidate)?.instance) === selectedPath,
    );
    const label = pathName(record(selected)?.path);
    if (label) sections.unshift({ label: tr('Selected interface'), text: label });
  }
  return sections;
}

function documentExcerpt(value: unknown): ToolSection[] | null {
  const chunk = record(value);
  if (!chunk || typeof chunk.offset !== 'number' || typeof chunk.totalBytes !== 'number')
    return null;
  if (chunk.offset === 0 && chunk.next == null && typeof chunk.text === 'string') {
    try {
      const document = record(JSON.parse(chunk.text));
      return deploymentContents(document?.input, document?.packages, tr('Included packages'));
    } catch {
      return null;
    }
  }
  const total = chunk.totalBytes;
  const last = typeof chunk.next === 'number' ? chunk.next : total;
  const range =
    last > chunk.offset
      ? tr('Bytes {first}–{last} of {total}', { first: chunk.offset + 1, last, total })
      : tr('Empty configuration');
  return [
    {
      label: tr('Configuration excerpt'),
      text: chunk.next == null ? range : `${range}\n${tr('More pages available')}`,
    },
  ];
}

function packageArguments(value: unknown): ToolSection[] | null {
  const args = record(value);
  const name = packageName(args?.package);
  if (!args || !name) return null;
  const sections = [{ label: tr('Package'), text: name }];
  if (typeof args.path === 'string' && args.path) {
    sections.push({ label: tr('File'), text: args.path });
  } else {
    const path = pathName(args.path);
    if (path) sections.push({ label: tr('Settings'), text: path });
  }
  return sections;
}

function packageSource(value: unknown): ToolSection[] | null {
  const output = record(value);
  if (!output || !Array.isArray(output.paths)) return null;
  if (typeof output.text === 'string') {
    const contents: ToolSection = {
      label: tr('Plugin source excerpt'),
      text: output.text,
      style: 'code',
    };
    return output.next == null
      ? [contents]
      : [{ label: tr('Files'), text: tr('More source available') }, contents];
  }
  const paths = output.paths.filter((path): path is string => typeof path === 'string');
  return [list(tr('Files'), paths, tr('No files in this package'))];
}

const refusalMessages = {
  invalid_bundle: 'The plugin bundle is invalid.',
  download_failed: 'The plugin bundle could not be downloaded.',
  invalid_document: 'The deployment document is invalid.',
  invalid_source: 'The selected deployment source is invalid.',
  package_unavailable: 'The selected package is unavailable.',
  instance_unavailable: 'The selected plugin instance is unavailable.',
  parent_disabled: 'Enable the parent plugin first.',
} as const;

function managementResult(value: unknown, installation = false): ToolSection[] | null {
  const result = record(value);
  switch (result?.status) {
    case 'committed': {
      if (installation) {
        const name = packageName(record(result.value)?.package);
        return name ? [{ label: tr('Plugin package installed'), text: name }] : null;
      }
      return [{ label: tr('Changes'), text: tr('Deployment change saved') }];
    }
    case 'conflict':
      return [
        {
          label: tr('Deployment conflict'),
          text: tr('The deployment changed before this edit could be saved.'),
          tone: 'warning',
        },
      ];
    case 'rejected': {
      const reason =
        typeof result.reason === 'string' && Object.hasOwn(refusalMessages, result.reason)
          ? refusalMessages[result.reason as keyof typeof refusalMessages]
          : null;
      return [
        {
          label: tr('Deployment change rejected'),
          text: tr(reason ?? 'Deployment change rejected'),
          tone: 'error',
        },
      ];
    }
    default:
      return null;
  }
}

function installationFiles(value: unknown): ToolSection[] | null {
  const files = record(record(value)?.files);
  return files ? [list(tr('Files'), Object.keys(files), tr('No files in this package'))] : null;
}

function downloadLocation(value: unknown): ToolSection[] | null {
  const url = record(value)?.url;
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.host
      ? [{ label: tr('Download location'), text: `${parsed.host}${parsed.pathname}` }]
      : [];
  } catch {
    return [];
  }
}

function compositionEdits(value: unknown): ToolSection[] | null {
  const edits = record(value)?.edits;
  if (!Array.isArray(edits)) return null;
  const rows = edits.flatMap((item) => {
    const edit = record(item);
    if (!edit || typeof edit.name !== 'string') return [];
    const name = edit.name;
    switch (edit.kind) {
      case 'insert': {
        const pkg = packageName(edit.package);
        return [
          pkg && pkg !== name
            ? `${tr('Add {name}', { name })} · ${pkg}`
            : tr('Add {name}', { name }),
        ];
      }
      case 'update':
        return [tr('Update {name}', { name })];
      case 'remove':
        return [tr('Remove {name}', { name })];
      default:
        return [];
    }
  });
  return rows.length ? [list(tr('Requested changes'), rows, '')] : [];
}

function availabilityChange(value: unknown): ToolSection[] | null {
  const enabled = record(value)?.enabled;
  return typeof enabled === 'boolean'
    ? [
        {
          label: tr('Requested change'),
          text: enabled ? tr('Enable plugin') : tr('Disable plugin'),
        },
      ]
    : null;
}

function settingChanges(value: unknown): ToolSection[] | null {
  const changes = record(value)?.changes;
  if (!Array.isArray(changes)) return null;
  const rows = changes.map((change) => pathName(record(change)?.path)).filter(nonempty);
  return rows.length ? [list(tr('Settings to update'), rows, '')] : [];
}

function settingsPath(value: unknown): ToolSection[] {
  const path = pathName(record(value)?.path);
  return path ? [{ label: tr('Settings'), text: path }] : [];
}

function settings(value: unknown): ToolSection[] | null {
  const page = record(value);
  if (!page || !Array.isArray(page.fields)) return null;
  const rows = page.fields.flatMap((item) => {
    const field = record(item);
    if (!field || typeof field.label !== 'string' || typeof field.present !== 'boolean') return [];
    return [`${field.label} · ${tr(field.present ? 'Has a value' : 'Not set')}`];
  });
  return [list(tr('Settings'), rows, tr('No settings on this page'), page.next != null)];
}

function bindingArguments(value: unknown): ToolSection[] | null {
  const args = record(value);
  if (!args || typeof args.import !== 'string') return null;
  const consumer = record(args.consumer);
  const name = typeof consumer?.name === 'string' ? consumer.name : packageName(consumer?.package);
  return [
    { label: tr('Requested connection'), text: name ? `${name} · ${args.import}` : args.import },
  ];
}

function bindingCandidates(value: unknown): ToolSection[] | null {
  const page = record(value);
  if (!page || !Array.isArray(page.candidates)) return null;
  const rows = page.candidates.flatMap((item) => {
    const candidate = record(item);
    if (!candidate) return [];
    const target = record(candidate.target);
    if (target?.kind === 'remote' && typeof target.export === 'string') return [target.export];
    return typeof candidate.label === 'string' ? [candidate.label] : [];
  });
  return [
    list(
      tr('Compatible plugins'),
      rows,
      tr('No compatible plugins on this page'),
      page.next != null,
    ),
  ];
}

function packageSettings(value: unknown): ToolSection[] | null {
  const sections = settings(value);
  const imports = record(value)?.imports;
  if (!sections || !Array.isArray(imports)) return sections;
  const names = imports.flatMap((item) => {
    const name = record(item)?.name;
    return typeof name === 'string' ? [name] : [];
  });
  if (names.length) sections.push(list(tr('Plugin connections'), names, ''));
  return sections;
}

function replacement(value: unknown): ToolSection[] | null {
  const document = record(record(value)?.document);
  return deploymentContents(document?.input, document?.packages, tr('Included packages'));
}

function presentation(
  title: MessageKey,
  icon: ActivityPresentation['icon'],
  result: NonNullable<ActivityPresentation['result']>,
  args?: ActivityPresentation['arguments'],
): ActivityPresentation {
  return { title: () => tr(title), icon, result, arguments: args };
}

const manager = 'maka.application.DeploymentManager@1/';
export const deploymentToolPresentations: Record<string, ActivityPresentation> = {
  [manager + 'read']: presentation('Inspect plugin deployment', 'settings', deployments),
  [manager + 'readUi']: presentation('Inspect interface plugins', 'app', (value) =>
    instances(value, true),
  ),
  [manager + 'instances']: presentation('List plugin instances', 'children', (value) =>
    instances(value, false),
  ),
  [manager + 'readDocument']: presentation(
    'Read deployment configuration',
    'file',
    documentExcerpt,
  ),
  [manager + 'readPackage']: presentation(
    'Read plugin source',
    'file',
    packageSource,
    packageArguments,
  ),
  [manager + 'installSource']: presentation(
    'Install plugin from source',
    'download',
    (value) => managementResult(value, true),
    installationFiles,
  ),
  [manager + 'installUrl']: presentation(
    'Install plugin from URL',
    'download',
    (value) => managementResult(value, true),
    downloadLocation,
  ),
  [manager + 'editComposition']: presentation(
    'Edit plugin deployment',
    'edit',
    (value) => managementResult(value),
    compositionEdits,
  ),
  [manager + 'setEnabled']: presentation(
    'Change plugin availability',
    'app',
    (value) => managementResult(value),
    availabilityChange,
  ),
  [manager + 'readSettings']: presentation(
    'Inspect plugin settings',
    'settings',
    settings,
    settingsPath,
  ),
  [manager + 'configure']: presentation(
    'Update plugin settings',
    'settings',
    (value) => managementResult(value),
    settingChanges,
  ),
  [manager + 'bindingCandidates']: presentation(
    'Find compatible plugins',
    'link',
    bindingCandidates,
    bindingArguments,
  ),
  [manager + 'packageSettings']: presentation(
    'Inspect package settings',
    'settings',
    packageSettings,
    packageArguments,
  ),
  [manager + 'replaceSource']: presentation(
    'Replace plugin deployment',
    'edit',
    (value) => managementResult(value),
    replacement,
  ),
};
