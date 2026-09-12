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

// Real native scrollbar input: stable held geometry, preserved reading anchor,
// and history progress after release. Fixed-range cold scrolling runs in CI too.
import { test, expect } from '@playwright/test';
import { withE2eWindow } from './fixtures';

test('native thumb keeps its geometry and releases history without moving the reader', async () => {
  test.setTimeout(180_000);
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
        const style = document.createElement('style');
        style.textContent = `
        [data-chat-scroll-container] { scroll-behavior:auto !important; scrollbar-width:auto !important; scrollbar-color:auto !important; }
        [data-chat-scroll-container]::-webkit-scrollbar { width:14px; }
        [data-chat-scroll-container]::-webkit-scrollbar-thumb { background:#777; min-height:0; border:0; }
        [data-chat-scroll-container]::-webkit-scrollbar-track { background:#ddd; }`;
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
      {
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
            pointerUp: 0,
            readingId: undefined as string | undefined,
            frames: [] as Array<{
              h: number;
              t: number;
              v: number;
              range: string;
              held: boolean;
              ms: number;
              anchorTop?: number;
            }>,
          };
          (window as any).__windowGeometry = state;
          root.addEventListener('pointerdown', () => {
            state.pointerDown++;
            state.held = true;
          });
          document.addEventListener('pointerup', () => {
            state.pointerUp++;
            state.held = false;
          });
          const frame = () => {
            const turns = [...root.querySelectorAll<HTMLElement>('.maka-transcript-turn')];
            state.frames.push({
              h: root.scrollHeight,
              t: root.scrollTop,
              v: root.clientHeight,
              range: turns.map((t) => t.dataset.transcriptTurnId).join(','),
              held: state.held,
              ms: performance.now(),
              anchorTop: state.readingId
                ? root.querySelector(`[data-turn-id="${state.readingId}"]`)?.getBoundingClientRect()
                    .top
                : undefined,
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
        const reading = await page.evaluate(() => {
          const root = document.querySelector('[data-chat-scroll-container]')!;
          const top = root.getBoundingClientRect().top;
          const turn = [...root.querySelectorAll<HTMLElement>('[data-turn-id]')].find(
            (el) => el.getBoundingClientRect().bottom > top,
          )!;
          (window as any).__windowGeometry.readingId = turn.dataset.turnId;
          return { id: turn.dataset.turnId!, top: turn.getBoundingClientRect().top };
        });
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: start.x,
          y: start.top + 8,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
        // A loaded runner can deliver fewer than three frames in 300ms. Keep
        // observing through the actual publication instead of stopping on time.
        await page.waitForFunction(() => {
          const state = (window as any).__windowGeometry;
          const held = state.frames.find((frame: any) => frame.held);
          const released = state.frames.filter((frame: any) => !frame.held && frame.anchorTop !== undefined);
          return released.length > 2 && released.some((frame: any) => frame.range !== held.range);
        }).catch(async (error) => {
          await test.info().attach('scroll-geometry-frames', {
            body: JSON.stringify(await page.evaluate(() => (window as any).__windowGeometry)),
            contentType: 'application/json',
          });
          throw error;
        });
        await page.evaluate(() => new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ));
        const result = await page.evaluate(() => {
          const state = (window as any).__windowGeometry;
          state.done = true;
          return state;
        });
        const held = result.frames.filter((f: any) => f.held);
        await test.info().attach('scroll-geometry-frames', {
          body: JSON.stringify(result),
          contentType: 'application/json',
        });
        const heightDrift =
          Math.max(...held.map((f: any) => f.h)) - Math.min(...held.map((f: any) => f.h));
        const ranges = new Set(held.map((f: any) => f.range));
        expect(result.pointerDown).toBe(1);
        expect(result.pointerUp).toBe(1);
        expect(heightDrift, 'height must remain constant while held').toBeLessThanOrEqual(1);
        expect(ranges.size, 'resident membership must remain constant while held').toBe(1);
        expect(
          Math.max(0, ...held.slice(1).map((f: any, i: number) => f.t - held[i].t)),
          'upward native drag must not reverse',
        ).toBeLessThanOrEqual(1);
        const released = result.frames.filter((f: any) => !f.held && f.anchorTop !== undefined);
        expect(
          Math.max(...released.map((f: any) => Math.abs(f.anchorTop - reading.top))),
          'reading anchor must survive every release frame',
        ).toBeLessThanOrEqual(1);
        await expect
          .poll(() =>
            page
              .locator('.maka-transcript-turn')
              .evaluateAll((els) =>
                els.map((el) => (el as HTMLElement).dataset.transcriptTurnId).join(','),
              ),
          )
          .not.toBe(held[0].range);
        const anchor = page.locator('[data-turn-id="' + reading.id + '"]');
        await expect(anchor).toHaveCount(1);
        await expect
          .poll(async () => Math.abs((await anchor.boundingBox())!.y - reading.top))
          .toBeLessThanOrEqual(1);
        await page
          .getByRole('button', {
            name: /^(?:滚动主对话到底部|Scroll main conversation to bottom)$/,
          })
          .click();
        await expect(page.locator('[data-turn-id="turn-prompt-rail-120"]')).toHaveCount(1);
        expect(
          Math.max(...held.map((f: any) => f.t)) - Math.min(...held.map((f: any) => f.t)),
          'native thumb drag must actually scroll',
        ).toBeGreaterThan(100);
      }
    },
  );
});
