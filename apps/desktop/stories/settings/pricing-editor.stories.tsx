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

import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastProvider } from '@maka/ui';
import {
  PricingEditor,
  UsagePricingServicesProvider,
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

// A mutate never runs at mount (CI does not autoplay), but the services shape
// must be honest, so return the base as an unchanged commit rather than throw.
const noopMutate: UsagePricingServices['mutatePricing'] = async (_host, base) => ({
  kind: 'saved',
  disposition: 'unchanged',
  snapshot: base,
});

function pricingServices(load: UsagePricingServices['loadPricing']): UsagePricingServices {
  return { loadPricing: load, mutatePricing: noopMutate };
}

function PricingTabPanel(props: { services: UsagePricingServices }) {
  return (
    <ToastProvider>
      <UsagePricingServicesProvider services={props.services}>
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
              runtimeHost={STORY_HOST}
              generationKey={GENERATION_KEY}
            />
          </div>
        </div>
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
  render: () => <PricingTabPanel services={pricingServices(async () => MIXED_SNAPSHOT)} />,
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
