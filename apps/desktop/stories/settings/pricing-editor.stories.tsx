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

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ToastProvider } from '@maka/ui';
import { createDefaultSettings } from '@maka/core/settings';
import {
  PricingEditor,
  UsagePricingServicesProvider,
  UsageFeatureScope,
  type UsageHostRef,
  type UsagePricingServices,
} from '../../src/renderer/features/usage/testing';
import type { DesktopPricingSnapshot } from '../../src/shared/desktop-pricing';

// The Pricing tab (#2015 / PR #4164) is per-Host: it loads against the settings-
// SELECTED Runtime Host threaded to it as a prop, not the app's active Host. A
// concrete Host is required — with none selected the tab shows its no-Host state
// (covered by the feature unit tests, not a reachable settings-surface state).
const STORY_HOST: UsageHostRef = { profileId: 'story-profile', hostId: 'story-host' };
const GENERATION_KEY = `${STORY_HOST.profileId}:${STORY_HOST.hostId}:e1`;
const USAGE_SERVICES = {
  loadUsageStats: async () => null,
  updateUsageSettings: async () => createDefaultSettings().usage,
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// A revision-consistent effective snapshot: two user overrides (可回退 =
// restore_builtin, and become_unpriced = Delete) — the only rows the
// overrides-only table shows — plus two built-ins that feed the Add flow's
// catalog picker (never the table). One override is a free local model (0/0) so
// the zero-rate formatting renders. Sources/reset effects are the raw Host
// fields — the editor derives the labels and action set, so this fixture shows
// the classification rather than asserting it.
const MIXED_SNAPSHOT: DesktopPricingSnapshot = {
  hostEpoch: 'story-epoch',
  connectionId: 'story-connection',
  revision: 7,
  entries: [
    { source: 'builtin', pricing: { modelKey: 'openai:gpt-5', inputUsdPer1M: 1.25, outputUsdPer1M: 10 } },
    {
      source: 'builtin',
      pricing: {
        modelKey: 'anthropic:claude-opus-4',
        inputUsdPer1M: 15,
        outputUsdPer1M: 75,
        cacheReadUsdPer1M: 1.5,
        cacheWriteUsdPer1M: 18.75,
      },
    },
    {
      source: 'custom',
      resetEffect: 'restore_builtin',
      pricing: { modelKey: 'zai:glm-4.7', inputUsdPer1M: 0.6, outputUsdPer1M: 2.2 },
    },
    {
      source: 'custom',
      resetEffect: 'become_unpriced',
      pricing: { modelKey: 'local:qwen3-coder', inputUsdPer1M: 0, outputUsdPer1M: 0 },
    },
  ],
};

const EMPTY_SNAPSHOT: DesktopPricingSnapshot = {
  hostEpoch: 'story-epoch',
  connectionId: 'story-connection',
  revision: 1,
  entries: [],
};

function pricingServices(
  load: UsagePricingServices['loadPricing'],
  mutate: UsagePricingServices['mutatePricing'] = async () => {
    throw new Error('This pricing story does not configure writes');
  },
): UsagePricingServices {
  return { loadPricing: load, mutatePricing: mutate };
}

function EditablePricingPanel() {
  const [services] = useState<UsagePricingServices>(() => {
    let snapshot = MIXED_SNAPSHOT;
    return pricingServices(async () => snapshot, async (_host, _base, mutation) => {
      // This browser fixture supports editing its existing custom rows and
      // deleting the local-only row. Host CAS/reconciliation has lower-tier tests.
      if (mutation.kind === 'upsert') {
        snapshot = {
          ...snapshot, revision: snapshot.revision + 1,
          entries: snapshot.entries.map((row) => row.pricing.modelKey === mutation.pricing.modelKey
            ? { ...row, pricing: mutation.pricing } : row),
        };
      } else {
        snapshot = {
          ...snapshot, revision: snapshot.revision + 1,
          entries: snapshot.entries.filter((row) => row.pricing.modelKey !== mutation.modelKey),
        };
      }
      return { kind: 'saved', disposition: 'committed', snapshot };
    });
  });
  return <PricingTabPanel services={services} />;
}

function PricingTabPanel(props: { services: UsagePricingServices }) {
  return (
    <ToastProvider>
      <UsagePricingServicesProvider services={props.services}>
        <UsageFeatureScope
          targetKey={GENERATION_KEY}
          services={USAGE_SERVICES}
          loadErrorTitle="Usage load failed"
          describeError={describeError}
        >
          {/* The Usage → 定价配置 tab panel wrapper the surface really renders the
              editor inside. The surrounding settings-surface chrome (modal, nav
              sidebar, the centered content column that bounds this width) is
              exercised by Product/Settings/Pages; this story isolates the tab's
              own content, capped at a representative content-column width so the
              table is not reviewed stretched to the full 1280 render frame. */}
          <div style={{ maxWidth: 720, marginInline: 'auto', padding: 'var(--space-6) var(--space-4)' }}>
            <div className="settingsUsageTabPanel">
              <PricingEditor
                describeError={describeError}
                target={{ host: STORY_HOST, generationKey: GENERATION_KEY, isCurrent: () => true }}
              />
            </div>
          </div>
        </UsageFeatureScope>
      </UsagePricingServicesProvider>
    </ToastProvider>
  );
}

const meta = {
  title: 'Product/Settings/Pricing',
} satisfies Meta;

export default meta;

type Story = StoryObj;

// Real path: 设置 → 使用统计 → 定价配置 on a Host with a couple of user overrides.
// The overrides-only table shows the custom rows (自定义, with Reset or Delete per
// their reset effect); the built-in catalog is reached only via the Add picker.
export const Populated: Story = {
  render: () => <EditablePricingPanel />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('内置', { exact: true })).not.toBeInTheDocument();
    await userEvent.click(await canvas.findByRole('button', { name: '编辑「zai:glm-4.7」定价' }));
    const dialogElement = await canvas.findByRole('dialog', { name: '编辑定价' });
    const dialog = within(dialogElement);
    const input = dialog.getByRole('textbox', { name: /输入价格/ });
    await userEvent.clear(input);
    await userEvent.type(input, '0.75');
    // The smoke runner also repeats this with real Enter input. userEvent's
    // implicit-submit implementation does not resolve an external form button.
    await userEvent.click(dialog.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByText('$0.75', { exact: true })).toBeVisible();
    await expect(canvas.getByRole('button', { name: '编辑「zai:glm-4.7」定价' })).toHaveFocus();

    // Deletion removes the opening action, so focus must return to stable Add.
    await userEvent.click(canvas.getByRole('button', { name: '删除「local:qwen3-coder」定价' }));
    const deletion = within(await canvas.findByRole('alertdialog', { name: '删除定价' }));
    await userEvent.click(deletion.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(canvas.queryByRole('alertdialog')).not.toBeInTheDocument());
    await expect(canvas.queryByText('local:qwen3-coder', { exact: true })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: '添加定价' })).toHaveFocus();
  },
};

// Real path: 设置 → 使用统计 → 定价配置 on a Host with no user overrides yet — the
// common default (built-ins are never listed). The table area shows the
// overrides-empty state prompting the user to Add one from the catalog.
export const Empty: Story = {
  render: () => <PricingTabPanel services={pricingServices(async () => EMPTY_SNAPSHOT)} />,
};

// Real path: 设置 → 使用统计 → 定价配置 on first open, before the Host's pricing
// snapshot resolves. The table reserves its geometry with skeleton rows so real
// rows land with no layout shift.
export const Loading: Story = {
  render: () => (
    <PricingTabPanel services={pricingServices(() => new Promise<DesktopPricingSnapshot>(() => {}))} />
  ),
};

// Real path: 设置 → 使用统计 → 定价配置 when reading the Host's pricing snapshot
// fails. The panel shows a load-failed empty state with a Retry action instead
// of the table.
export const LoadFailed: Story = {
  render: () => (
    <PricingTabPanel
      services={pricingServices(async () => {
        throw new Error('Runtime Host pricing snapshot unreachable');
      })}
    />
  ),
};

// Real path: Add price → manual fallback. The form accepts the exact Runtime
// lookup key as one copy/paste-safe value instead of making the user reconstruct
// it from separate provider/model fields.
export const ManualExactKey: Story = {
  render: () => <PricingTabPanel services={pricingServices(async () => MIXED_SNAPSHOT)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const add = await canvas.findByRole('button', { name: '添加定价' });
    await userEvent.click(add);
    let dialog = within(await canvas.findByRole('dialog', { name: '添加定价' }));
    const model = dialog.getByRole('combobox');
    await expect(model).toHaveAttribute('aria-required', 'true');
    await expect(model).not.toHaveAttribute('aria-invalid', 'true');
    // An empty catalog submission must focus the model before the empty rates.
    await userEvent.click(dialog.getByRole('button', { name: '保存' }));
    await expect(model).toHaveAttribute('aria-invalid', 'true');
    await expect(model).toHaveAccessibleDescription(/必填/);
    await expect(model).toHaveFocus();
    await userEvent.type(dialog.getByRole('textbox', { name: /输入价格/ }), '1');
    const output = dialog.getByRole('textbox', { name: /输出价格/ });
    await userEvent.type(output, '2');
    await expect(output).toHaveFocus();
    // With valid rates, the model is the only error and still receives focus.
    await userEvent.click(dialog.getByRole('button', { name: '保存' }));
    await expect(model).toHaveFocus();
    await userEvent.type(model, 'openai:gpt-5');
    await userEvent.click(await within(document.body).findByRole('option', { name: 'openai:gpt-5' }));
    await expect(model).not.toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByRole('textbox', { name: /输入价格/ })).toHaveValue('1.25');
    await userEvent.click(dialog.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(add).toHaveFocus();
    await userEvent.click(add);
    dialog = within(await canvas.findByRole('dialog', { name: '添加定价' }));
    await userEvent.click(dialog.getByRole('button', { name: '模型不在列表中？手动输入' }));
    await userEvent.type(dialog.getByRole('textbox', { name: /^模型键/ }), 'acme:coder-v3');
  },
};

// Real path: Edit an override → enter an invalid cache price → collapse cache
// prices → Save. The invalid field must become visible and receive focus.
export const Validation: Story = {
  render: () => <PricingTabPanel services={pricingServices(async () => MIXED_SNAPSHOT)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: '编辑「zai:glm-4.7」定价' }));
    const dialog = within(await canvas.findByRole('dialog', { name: '编辑定价' }));
    const cacheToggle = dialog.getByRole('button', { name: /缓存价格/ });
    await userEvent.click(cacheToggle);
    const cacheRead = dialog.getByRole('textbox', { name: /缓存读取/ });
    await userEvent.type(cacheRead, 'invalid');
    await userEvent.click(cacheToggle);
    await userEvent.click(dialog.getByRole('button', { name: '保存' }));
    await expect(cacheToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(cacheRead).toHaveAttribute('aria-invalid', 'true');
    await expect(cacheRead).toBeVisible();
    await waitFor(() => expect(cacheRead).toHaveFocus());
    await userEvent.click(dialog.getByRole('button', { name: '保存' }));
    await expect(cacheRead).toHaveFocus();
    const output = dialog.getByRole('textbox', { name: /输出价格/ });
    await userEvent.clear(output);
    await userEvent.type(output, '23');
    await expect(output).toHaveValue('23');
    await expect(output).toHaveFocus();
    await expect(cacheRead).toHaveValue('invalid');
    // Leave the visual state at the error, as another explicit Save would.
    await userEvent.click(dialog.getByRole('button', { name: '保存' }));
    await expect(cacheRead).toHaveFocus();
  },
};

// Real path: Edit an override → another client changes its prices → Save. The
// Host returns the current snapshot, while the user's draft remains for review.
export const Conflict: Story = {
  render: () => <PricingTabPanel services={pricingServices(async () => MIXED_SNAPSHOT, async () => ({
    kind: 'review_required',
    reason: 'revision_conflict',
    snapshot: {
      ...MIXED_SNAPSHOT,
      revision: 8,
      entries: MIXED_SNAPSHOT.entries.map((row) => row.pricing.modelKey === 'zai:glm-4.7'
        ? { ...row, pricing: { ...row.pricing, inputUsdPer1M: 7, outputUsdPer1M: 8, cacheReadUsdPer1M: 0, cacheWriteUsdPer1M: 0.4 } }
        : row),
    },
  }))} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: '编辑「zai:glm-4.7」定价' }));
    const dialogElement = await canvas.findByRole('dialog', { name: '编辑定价' });
    const dialog = within(dialogElement);
    const input = dialog.getByRole('textbox', { name: /输入价格/ });
    await userEvent.clear(input);
    await userEvent.type(input, '1.25');
    await userEvent.click(dialog.getByRole('button', { name: '保存' }));
    await expect(await dialog.findByText('定价已被其他修改更新')).toBeVisible();
    await expect(input).toHaveValue('1.25');
    const latest = dialog.getByText(/当前最新：/);
    await expect(latest).toHaveTextContent('$7');
    await expect(latest).toHaveTextContent('$0.4');
    await expect(dialog.getByRole('button', { name: '核对并保存' })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(dialogElement.contains(document.activeElement)).toBe(true);
  },
};

// Real path: Edit an override → the dispatched write loses its result and the
// recovery read fails. The open draft offers Refresh and blocks further writes.
export const Uncertain: Story = {
  render: () => <PricingTabPanel services={pricingServices(async () => MIXED_SNAPSHOT, async () => ({
    kind: 'reconciliation_unavailable', reason: 'outcome_unknown',
  }))} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: '编辑「zai:glm-4.7」定价' }));
    const dialogElement = await canvas.findByRole('dialog', { name: '编辑定价' });
    const dialog = within(dialogElement);
    const input = dialog.getByRole('textbox', { name: /输入价格/ });
    await userEvent.clear(input);
    await userEvent.type(input, '1.25');
    await userEvent.click(dialog.getByRole('button', { name: '保存' }));
    await expect(await dialog.findByText('无法确认结果')).toBeVisible();
    await expect(input).toHaveValue('1.25');
    await expect(dialog.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByRole('button', { name: '刷新' })).toBeVisible();
    await expect(dialogElement.contains(document.activeElement)).toBe(true);
  },
};
