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

import { expect, test } from './fixtures';

test('first-run onboarding stays within the chat viewport', async ({ onboardingWindow }) => {
  const geometry = await onboardingWindow.evaluate(() => {
    const pageRoot = document.scrollingElement;
    const scrollContainer = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    const surface = document.querySelector<HTMLElement>('[data-maka-contract="onboarding-surface"]');
    const card = document.querySelector<HTMLElement>('[data-maka-contract="onboarding-card"]');
    if (!pageRoot || !scrollContainer || !surface || !card) {
      throw new Error('Onboarding geometry is unavailable');
    }

    const scrollRect = scrollContainer.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      pageClientHeight: pageRoot.clientHeight,
      pageScrollHeight: pageRoot.scrollHeight,
      clientHeight: scrollContainer.clientHeight,
      scrollHeight: scrollContainer.scrollHeight,
      surfaceTop: surfaceRect.top,
      surfaceBottom: surfaceRect.bottom,
      viewportTop: scrollRect.top,
      viewportBottom: scrollRect.bottom,
      cardTop: cardRect.top,
      cardBottom: cardRect.bottom,
    };
  });

  expect(geometry.pageScrollHeight, JSON.stringify(geometry, null, 2)).toBe(
    geometry.pageClientHeight,
  );
  expect(geometry.scrollHeight, JSON.stringify(geometry, null, 2)).toBe(geometry.clientHeight);
  expect(geometry.surfaceTop).toBeGreaterThanOrEqual(geometry.viewportTop);
  expect(geometry.surfaceBottom).toBeLessThanOrEqual(geometry.viewportBottom);
  expect(geometry.cardTop).toBeGreaterThanOrEqual(geometry.viewportTop);
  expect(geometry.cardBottom).toBeLessThanOrEqual(geometry.viewportBottom);
});

test('first-run onboarding remains reachable at the minimum window size', async ({
  onboardingWindow,
}) => {
  await onboardingWindow.setViewportSize({ width: 480, height: 320 });

  const surface = onboardingWindow.locator('[data-maka-contract="onboarding-surface"]');
  const initialScrollTop = await surface.evaluate((element) => element.scrollTop);
  await surface.hover();
  await onboardingWindow.mouse.wheel(0, 10_000);
  await expect.poll(() => surface.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    initialScrollTop,
  );

  const geometry = await onboardingWindow.evaluate(() => {
    const pageRoot = document.scrollingElement;
    const scrollContainer = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    const surface = document.querySelector<HTMLElement>('[data-maka-contract="onboarding-surface"]');
    const content = surface?.querySelector<HTMLElement>('.maka-onboarding-center');
    if (!pageRoot || !scrollContainer || !surface || !content) {
      throw new Error('Onboarding geometry is unavailable');
    }

    const scrollRect = scrollContainer.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();

    return {
      windowInnerWidth: window.innerWidth,
      windowInnerHeight: window.innerHeight,
      pageClientHeight: pageRoot.clientHeight,
      pageScrollHeight: pageRoot.scrollHeight,
      viewportClientHeight: scrollContainer.clientHeight,
      viewportScrollHeight: scrollContainer.scrollHeight,
      viewportTop: scrollRect.top,
      viewportBottom: scrollRect.bottom,
      surfaceClientHeight: surface.clientHeight,
      surfaceScrollHeight: surface.scrollHeight,
      surfaceTop: surfaceRect.top,
      surfaceBottom: surfaceRect.bottom,
      finalScrollTop: surface.scrollTop,
      contentBottom: contentRect.bottom,
    };
  });

  expect(geometry.windowInnerWidth).toBe(480);
  expect(geometry.windowInnerHeight).toBe(320);
  expect(geometry.pageScrollHeight, JSON.stringify(geometry, null, 2)).toBe(
    geometry.pageClientHeight,
  );
  expect(geometry.viewportScrollHeight, JSON.stringify(geometry, null, 2)).toBe(
    geometry.viewportClientHeight,
  );
  expect(geometry.surfaceScrollHeight).toBeGreaterThan(geometry.surfaceClientHeight);
  expect(initialScrollTop).toBe(0);
  expect(geometry.finalScrollTop).toBeGreaterThan(initialScrollTop);
  expect(geometry.surfaceTop).toBeGreaterThanOrEqual(geometry.viewportTop);
  expect(geometry.surfaceBottom).toBeLessThanOrEqual(geometry.viewportBottom);
  expect(geometry.contentBottom).toBeLessThanOrEqual(geometry.surfaceBottom);
});
