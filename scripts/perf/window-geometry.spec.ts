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

// Manual evidence probe on the real Host/window path, deliberately separate
// from fixed-membership geometry. A pass means input/measurement worked, not
// that the reported height/range changes satisfy the future product contract.
import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withE2eWindow } from '../../apps/desktop/e2e/fixtures';

test('record native thumb drag through transcript window changes', async () => {
  test.setTimeout(180_000);
  const rows: unknown[] = [];
  await withE2eWindow(
    {
      seed: false,
      readinessSelector: '[data-turn-id]',
      e2eFixtureScenario: 'chat-prompt-rail',
      locale: 'zh-CN',
      showWindow: true,
    },
    async (page) => {
      await page.setViewportSize({ width: 1000, height: 700 });
      const cdp = await page.context().newCDPSession(page);
      await page.addInitScript(() => {
        const mode = sessionStorage.getItem('geometry-mode');
        const style = document.createElement('style');
        style.textContent = `
        [data-chat-scroll-container] { scroll-behavior:auto !important; scrollbar-width:auto !important; scrollbar-color:auto !important; }
        [data-chat-scroll-container]::-webkit-scrollbar { width:14px; }
        [data-chat-scroll-container]::-webkit-scrollbar-thumb { background:#777; min-height:0; border:0; }
        [data-chat-scroll-container]::-webkit-scrollbar-track { background:#ddd; }
        ${mode === 'no-skip' ? '.maka-transcript-turn, [data-maka-transcript-boundary], .astryx-codeblock [style*="contain-intrinsic-block-size"]' : ':not(*)'} {
          content-visibility:visible !important; contain:layout style paint !important;
        }`;
        const append = () => document.documentElement.append(style);
        if (document.documentElement) append();
        else
          new MutationObserver((_, observer) => {
            if (document.documentElement) {
              append();
              observer.disconnect();
            }
          }).observe(document, { childList: true });
      });
      for (const mode of ['baseline', 'no-skip', 'no-skip', 'baseline']) {
        await page.evaluate((mode) => sessionStorage.setItem('geometry-mode', mode), mode);
        await page.reload();
        await expect(page.locator('[data-turn-id]').first()).toBeVisible();
        const returnLatest = page.getByRole('button', {
          name: /^(?:滚动主对话到底部|Scroll main conversation to bottom)$/,
        });
        if (await returnLatest.isVisible()) await returnLatest.click();
        await expect(page.locator('[data-turn-id="turn-prompt-rail-120"]')).toHaveCount(1, {
          timeout: 30_000,
        });
        await page.evaluate(() => document.fonts.ready);
        // Baseline app admission, not a geometry-settled assertion. Prefetch can
        // still happen during the subsequent held drag and must be recorded.
        await page.waitForTimeout(500);
        const start = await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>('[data-chat-scroll-container]')!;
          const box = root.getBoundingClientRect();
          const state = {
            held: false,
            done: false,
            pointerDown: 0,
            frames: [] as Array<{
              h: number;
              t: number;
              v: number;
              range: string;
              held: boolean;
              ms: number;
            }>,
          };
          (window as any).__windowGeometry = state;
          root.addEventListener('pointerdown', () => state.pointerDown++);
          const frame = () => {
            const turns = [...root.querySelectorAll<HTMLElement>('.maka-transcript-turn')];
            state.frames.push({
              h: root.scrollHeight,
              t: root.scrollTop,
              v: root.clientHeight,
              range: turns.map((t) => t.dataset.transcriptTurnId).join(','),
              held: state.held,
              ms: performance.now(),
            });
            if (!state.done) requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
          return {
            x: box.right - 7,
            top: box.top,
            v: root.clientHeight,
            h: root.scrollHeight,
            t: root.scrollTop,
            gutter: root.offsetWidth - root.clientWidth,
          };
        });
        expect(start.gutter, 'a real classic scrollbar must be present').toBeGreaterThanOrEqual(12);
        expect(start.h).toBeGreaterThan(start.v);
        const startY = start.top + ((start.t + start.v / 2) * start.v) / start.h;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: startY });
        await page.evaluate(() => {
          (window as any).__windowGeometry.held = true;
        });
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: start.x,
          y: startY,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        for (let step = 1; step <= 40; step++) {
          const y = startY + ((start.top + 8 - startY) * step) / 40;
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: start.x,
            y,
            button: 'left',
            buttons: 1,
          });
          await page.waitForTimeout(25);
        }
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.resolve(`perf-results/window-held-${mode}.png`) });
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: start.x,
          y: start.top + 8,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
        await page.evaluate(() => {
          (window as any).__windowGeometry.held = false;
        });
        await page.waitForTimeout(300);
        const result = await page.evaluate(() => {
          const state = (window as any).__windowGeometry;
          state.done = true;
          return state;
        });
        const held = result.frames.filter((f: any) => f.held);
        const heightDrift =
          Math.max(...held.map((f: any) => f.h)) - Math.min(...held.map((f: any) => f.h));
        const ranges = new Set(held.map((f: any) => f.range));
        expect(
          Math.max(...held.map((f: any) => f.t)) - Math.min(...held.map((f: any) => f.t)),
          'native thumb drag must actually scroll',
        ).toBeGreaterThan(100);
        rows.push({ mode, start, heightDrift, heldRanges: ranges.size, ...result });
        await mkdir('perf-results', { recursive: true });
        await writeFile('perf-results/window-geometry.json', JSON.stringify({ rows }, null, 2));
        console.log(
          JSON.stringify({
            mode,
            heightDrift,
            heldRanges: ranges.size,
            pointerDown: result.pointerDown,
          }),
        );
      }
    },
  );
});
