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
import { expect, fn, userEvent, within } from 'storybook/test';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import type { HostHandoffAttentionView } from '@maka/runtime-host/client';
import { RuntimeHostHandoffOverlay } from '../src/renderer/features/runtime-host-management/index.js';
import { RuntimeHostManagementServicesProvider } from '../src/renderer/features/runtime-host-management/index.js';
import {
  createDesktopRuntimeHostManagementServices,
  type DesktopRuntimeHostManagementBridge,
} from '../src/renderer/platform/desktop/create-runtime-host-management-services';
import type { DesktopHostHandoffPayload } from '../src/preload/bridge-contract.js';

const meta = {
  title: 'Product/Runtime Host Handoff',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const decide = fn(async () => undefined);

function handoffServices(payload: DesktopHostHandoffPayload) {
  return createDesktopRuntimeHostManagementServices({
    runtimeHostHandoff: {
      current: async () => payload,
      subscribe: () => () => {},
      decide,
    },
  } as unknown as DesktopRuntimeHostManagementBridge);
}

function renderWithServices(payload: DesktopHostHandoffPayload) {
  return () => (
    <LocaleProvider locale="en">
      <AstryxLocaleProvider>
        <ToastProvider>
          <RuntimeHostManagementServicesProvider services={handoffServices(payload)}>
            <RuntimeHostHandoffOverlay />
          </RuntimeHostManagementServicesProvider>
        </ToastProvider>
      </AstryxLocaleProvider>
    </LocaleProvider>
  );
}

const replacementView: HostHandoffAttentionView = {
  revision: 'handoff-replacement',
  state: 'attention',
  reason: 'replacement_required',
  target: { name: 'Local', location: 'local' },
  mayExitNaturally: false,
  packageChange: { current: '0.1.0-dev.38', target: '0.1.0-dev.40' },
  actions: ['cancel', 'replace'],
  defaultAction: 'cancel',
};

// Mirrors the en formatHostHandoff output for this view — the payload the
// main process sends over the runtimeHostHandoff bridge.
const replacementPayload: DesktopHostHandoffPayload = {
  view: replacementView,
  presentation: {
    title: 'Switch the WSL background service',
    description:
      'No update is running. Continue to retire the old service through its installed operator and start the selected version. Interrupting active work requires a separate confirmation.',
    detail:
      'Local: 0.1.0-dev.38 → 0.1.0-dev.40\nMaka keeps checking. Waiting or retrying will not resolve this unless the service state changes.',
    actions: [
      { action: 'cancel', label: 'Cancel' },
      { action: 'replace', label: 'Stop old service and continue' },
    ],
  },
};

// Real path: launch while a managed Runtime Host update needs package-change
// consent — the main window mounts the overlay above the shell.
export const ReplacementConsent: Story = {
  render: renderWithServices(replacementPayload),
  play: async ({ canvasElement }) => {
    decide.mockClear();
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole('alertdialog');
    await expect(within(dialog).getByText(/0\.1\.0-dev\.38/u)).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Stop old service and continue' }),
    );
    await expect(decide).toHaveBeenCalledWith('handoff-replacement', 'replace');
  },
};

const retryPayload: DesktopHostHandoffPayload = {
  view: {
    revision: 'handoff-retry',
    state: 'attention',
    reason: 'retry_required',
    target: { name: 'Local', location: 'local' },
    mayExitNaturally: false,
    actions: ['cancel'],
    defaultAction: 'cancel',
  },
  presentation: {
    title: 'The handoff could not finish yet',
    description:
      'The service changed or the handoff has not finished. A safe retry will not interrupt work by default.',
    detail:
      'Maka keeps checking. Waiting or retrying will not resolve this unless the service state changes.',
    actions: [{ action: 'cancel', label: 'Cancel' }],
  },
};

// Real path: a Local Host update failed after retries were exhausted — the
// only offered action is the one the surface advertised (#5476's stuck view).
export const RetryExhausted: Story = {
  render: renderWithServices(retryPayload),
  play: async ({ canvasElement }) => {
    decide.mockClear();
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await expect(decide).toHaveBeenCalledWith('handoff-retry', 'cancel');
  },
};

// Real path: the same launch while reconciliation is still in progress —
// progress views stay silent and nothing mounts.
export const ProgressStaysSilent: Story = {
  render: renderWithServices({
    view: {
      revision: 'handoff-progress',
      state: 'progress',
      phase: 'staging',
      target: { name: 'Local', location: 'local' },
      mayExitNaturally: false,
      actions: ['cancel'],
      defaultAction: 'cancel',
    },
    presentation: {
      title: 'Continuing to your workspace',
      description: 'Preparing the update',
      detail: 'Finishing the handoff or its safe recovery. Please wait.',
      actions: [{ action: 'cancel', label: 'Cancel' }],
    },
  }),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(body.queryByRole('alertdialog')).toBeNull();
  },
};
