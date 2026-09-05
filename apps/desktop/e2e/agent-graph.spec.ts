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

import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures';

async function expectInsideViewport(target: Locator, viewport: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const targetBox = await target.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });
      const viewportBox = await viewport.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left + element.clientLeft,
          top: rect.top + element.clientTop,
          right: rect.left + element.clientLeft + element.clientWidth,
          bottom: rect.top + element.clientTop + element.clientHeight,
        };
      });
      const tolerance = 1;
      return Boolean(
        targetBox.left >= viewportBox.left - tolerance &&
          targetBox.top >= viewportBox.top - tolerance &&
          targetBox.right <= viewportBox.right + tolerance &&
          targetBox.bottom <= viewportBox.bottom + tolerance,
      );
    })
    .toBe(true);
}

function metadataValue(scope: Locator, label: string): Locator {
  return scope
    .locator('dt')
    .filter({ hasText: label })
    .locator('xpath=following-sibling::dd[1]');
}

async function expectMetadata(
  scope: Locator,
  label: string,
  value: string | RegExp,
): Promise<void> {
  await expect(metadataValue(scope, label)).toHaveText(value);
}

test('keeps liveness signals in both views and respects reduced motion', async ({
  agentGraphTopologyWindow: page,
}) => {
  const panel = page.getByRole('region', { name: 'Agent Graph', exact: true });
  await expect(panel).toHaveAttribute('data-live', 'true');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-maka-e2e-fixture');
    document.documentElement.removeAttribute('data-maka-reduced-motion');
  });
  const heartbeat = panel.locator('.maka-agent-graph-heartbeat');
  const runningDot = panel.locator('.maka-agent-graph-status-dot[data-status="running"]').first();
  await expect(heartbeat).toBeVisible();
  await expect(heartbeat).toHaveAttribute('aria-hidden', 'true');
  await expect(runningDot).toHaveCSS('animation-name', 'maka-agent-graph-dot-pulse');
  await expect(runningDot).toHaveCSS('animation-iteration-count', 'infinite');
  await panel.getByRole('radio', { name: 'List' }).click();
  await expect(runningDot).toHaveCSS('animation-name', 'maka-agent-graph-dot-pulse');
  await expect(runningDot).toHaveCSS('animation-iteration-count', 'infinite');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(heartbeat).toBeHidden();
  await expect(runningDot).toHaveCSS('animation-iteration-count', '1');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => document.documentElement.setAttribute('data-maka-reduced-motion', 'true'));
  await expect(heartbeat).toBeHidden();
  await expect(runningDot).toHaveCSS('animation-iteration-count', '1');
});

test('inspects and follows an operator across graph views', async ({
  agentGraphTopologyWindow: page,
}) => {
  const panel = page.getByRole('region', { name: 'Agent Graph', exact: true });
  const topology = page.getByTestId('agent-graph-topology');

  await expect
    .poll(() =>
      topology.evaluate((element) => ({
        horizontal: element.scrollWidth > element.clientWidth,
        vertical: element.scrollHeight > element.clientHeight,
      })),
    )
    .toEqual({ horizontal: true, vertical: true });

  const initialPublisherNode = topology.getByRole('button', { name: /^publisher\./u });
  await initialPublisherNode.click();
  await expect(initialPublisherNode).toBeFocused();
  await expectInsideViewport(initialPublisherNode, topology);
  await expectInsideViewport(initialPublisherNode, panel);
  await expect(page.getByRole('region', { name: 'Operator details: publisher' })).toBeAttached();
  await initialPublisherNode.click();

  await panel.getByRole('radio', { name: 'List' }).click();
  const publisherRow = panel
    .getByTestId('agent-graph-list')
    .locator(':scope > li')
    .filter({ has: page.getByText('publisher', { exact: true }) });
  await expect(publisherRow.getByText('Completed', { exact: true })).toBeVisible();
  await expect(publisherRow).toContainText('1 more work item omitted');

  const detailsButton = publisherRow.getByRole('button', {
    name: 'View publisher details',
  });
  await detailsButton.click();
  await expect(detailsButton).toBeFocused();
  await expect(detailsButton).toHaveAttribute('aria-expanded', 'true');
  const details = page.getByRole('region', { name: 'Operator details: publisher' });
  await expect(details).toHaveAttribute('aria-busy', 'false');
  const collection = (name: string) =>
    details
      .locator('.maka-agent-graph-details-collection')
      .filter({ has: page.getByText(name, { exact: true }) });
  const publisherSessionId = /^\["[a-f0-9]{64}","child-publisher"\]$/u;
  const activations = collection('Activations');
  const activation = activations.locator('li');
  await expect(
    metadataValue(activation, 'firstEventTime').locator(
      'time[datetime="2026-05-22T02:59:57.000Z"]',
    ),
  ).toBeVisible();
  await expect(
    metadataValue(activation, 'lastEventTime').locator(
      'time[datetime="2026-05-22T02:59:59.000Z"]',
    ),
  ).toBeVisible();
  await expectMetadata(activation, 'lastRecordId', 'record-publisher-terminal');
  await expectMetadata(activation, 'terminalRecordId', 'record-publisher-terminal');
  await expectMetadata(activation, 'run.sessionId', publisherSessionId);
  await expectMetadata(activation, 'run.agentRunId', 'run-publisher');
  await expectMetadata(activation, 'run.turnId', 'turn-publisher');

  const claims = collection('Claims');
  const claim = claims.locator('li').filter({ hasText: 'claim-publisher' });
  await expectMetadata(claim, 'intentId', 'intent-publisher');
  await expectMetadata(claim, 'childSessionId', publisherSessionId);
  await expect(
    metadataValue(claim, 'claimedAt').locator('time[datetime="2026-05-22T02:59:56.000Z"]'),
  ).toBeVisible();
  await expectMetadata(claim, 'run.sessionId', publisherSessionId);
  await expectMetadata(claim, 'run.agentRunId', 'run-publisher');
  await expectMetadata(claim, 'run.turnId', 'turn-publisher');

  const activity = collection('Recent activity');
  const permissionRecord = activity.locator('li').filter({ hasText: 'record-publisher-permission' });
  await expectMetadata(permissionRecord, 'activationId', 'activation-publisher');
  await expectMetadata(permissionRecord, 'signals', 'attention: permission request');
  await expect(
    metadataValue(permissionRecord, 'eventTime').locator(
      'time[datetime="2026-05-22T02:59:57.000Z"]',
    ),
  ).toBeVisible();
  await expectMetadata(permissionRecord, 'run.sessionId', publisherSessionId);
  await expectMetadata(permissionRecord, 'run.agentRunId', 'run-publisher');
  await expectMetadata(permissionRecord, 'run.turnId', 'turn-publisher');
  const terminalRecord = activity.locator('li').filter({ hasText: 'record-publisher-terminal' });
  await expectMetadata(terminalRecord, 'activationId', 'activation-publisher');
  await expectMetadata(terminalRecord, 'signals', 'terminal: completed');
  await expect(
    metadataValue(terminalRecord, 'eventTime').locator(
      'time[datetime="2026-05-22T02:59:59.000Z"]',
    ),
  ).toBeVisible();
  await expectMetadata(terminalRecord, 'run.sessionId', publisherSessionId);
  await expectMetadata(terminalRecord, 'run.agentRunId', 'run-publisher');
  await expectMetadata(terminalRecord, 'run.turnId', 'turn-publisher');
  await expectInsideViewport(detailsButton, panel);
  await expectInsideViewport(details.locator('.maka-agent-graph-details-heading'), panel);

  await panel.getByRole('radio', { name: 'Topology' }).click();
  const selectedNode = topology.locator('.maka-agent-graph-node[data-selected="true"]');
  await expect(selectedNode).toContainText('publisher');
  await expect(selectedNode).toContainText('1 more work item omitted');
  await expectInsideViewport(selectedNode, topology);
  await expectInsideViewport(selectedNode, panel);
  await expect.poll(() => topology.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  await panel.getByRole('button', { name: 'Collapse Agent Graph' }).click();
  await panel.getByRole('button', { name: 'Expand Agent Graph' }).click();
  await expectInsideViewport(selectedNode, topology);
  await expectInsideViewport(selectedNode, panel);

  await panel.getByRole('radio', { name: 'List' }).click();
  await expectInsideViewport(detailsButton, panel);
  await expectInsideViewport(details.locator('.maka-agent-graph-details-heading'), panel);
});
