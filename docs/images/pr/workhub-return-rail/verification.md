<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# WorkHub return and rail verification

Base application source: `11b93d111`. Fix: PR #5177.

The baseline renderer was built by restoring the changed production source files from the base commit, rebuilding `@maka/ui` and Desktop renderer, and running the current regression against that build. The regression itself is intentionally new. The fixed production files were saved and restored afterward. No baseline application fix or test assertion was applied.

## Comparable screenshots

`before-workhub.png` and `after-workhub.png`: 1600 × 800 CSS pixels, `scale: css`, same light theme, three non-empty prompts, three completed replies, and exactly three visible rail ticks before capture. On base, the measured right inset is 412px, failing the <=32px guard. The fixed regression passes, including direct Session/WorkHub inset comparison within 1px.

## Existing layout test failure

The earlier unmodified-base run failed at `workhub-layout.spec.ts:75`: horizontal drag left `scrollLeft` at 0, expected >250. Its original output is retained below. A fresh baseline run during review failed earlier at line 56: native WorkHub width remained 2496 while the expected dock width was 996. That run did not reach the drag assertion. These observations establish baseline-local failures, not a diagnosed product cause or a proven intermittent flake. No claim is made that either failure reproduces on Linux CI.

Commands run from `apps/desktop`:

```sh
npx playwright test --config e2e/playwright.config.ts workhub-layout.spec.ts --grep 'coordination model' --reporter=line
npx playwright test --config e2e/playwright.config.ts workhub-return-rail.spec.ts workhub-layout.spec.ts --grep 'prompt rail uses|coordination model' --reporter=line
```

### Earlier base output

```text

Running 1 test using 1 worker

(node:68936) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)


[1/1] e2e/workhub-layout.spec.ts:23:1 › WorkHub uses its coordination model and shared attachment composer
  1) e2e/workhub-layout.spec.ts:23:1 › WorkHub uses its coordination model and shared attachment composer

    Error: expect(received).toBeGreaterThan(expected)

    Expected: > 250
    Received:   0

    Call Log:
    - Timeout 10000ms exceeded while waiting on the predicate

      73 |   await workhub.mouse.move(dragStart.x - 300, dragStart.y, { steps: 12 });
      74 |   await workhub.mouse.up();
    > 75 |   await expect.poll(() => anchors.evaluate((element) => element.scrollLeft)).toBeGreaterThan(250);
         |                                                                              ^
      76 |   await expect(page.locator('.workHubDock')).toBeVisible();
      77 |   await expect(workhub.locator(COMPOSER_INPUT)).toHaveText(draftBeforeOverlays);
      78 |   await workhub.mouse.move(dragStart.x - 300, dragStart.y);
        at /private/tmp/maka-workhub-return-rail/apps/desktop/e2e/workhub-layout.spec.ts:75:78

    attachment #1: screenshot (image/png) ──────────────────────────────────────────────────────────
    e2e/test-results/workhub-layout-WorkHub-use-b1317--shared-attachment-composer/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #2: screenshot (image/png) ──────────────────────────────────────────────────────────
    e2e/test-results/workhub-layout-WorkHub-use-b1317--shared-attachment-composer/test-failed-2.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: e2e/test-results/workhub-layout-WorkHub-use-b1317--shared-attachment-composer/error-context.md

    attachment #4: trace (application/zip) ─────────────────────────────────────────────────────────
    e2e/test-results/workhub-layout-WorkHub-use-b1317--shared-attachment-composer/trace.zip
    Usage:

        npx playwright show-trace e2e/test-results/workhub-layout-WorkHub-use-b1317--shared-attachment-composer/trace.zip

    ────────────────────────────────────────────────────────────────────────────────────────────────


  1 failed
    e2e/workhub-layout.spec.ts:23:1 › WorkHub uses its coordination model and shared attachment composer

```

### Fresh base output

```text

Running 2 tests using 1 worker

(node:19651) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)


[1/2] e2e/workhub-layout.spec.ts:23:1 › WorkHub uses its coordination model and shared attachment composer
  1) e2e/workhub-layout.spec.ts:23:1 › WorkHub uses its coordination model and shared attachment composer

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 996
    Received: 2496

    Call Log:
    - Timeout 10000ms exceeded while waiting on the predicate

      54 |     await expect.poll(() => page.evaluate(() => innerWidth)).toBe(contentWidth);
      55 |     const dockWidth = await page.locator('.workHubDock').evaluate((element) => Math.round(element.getBoundingClientRect().width));
    > 56 |     await expect.poll(() => workhub.evaluate(() => innerWidth)).toBe(dockWidth);
         |                                                                 ^
      57 |     const rail = workhub.locator('.workhub-anchor-rail');
      58 |     await expect.poll(() => rail.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(180);
      59 |     await expect.poll(() => rail.locator('.workhub-navigation-label').first().evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(140);
        at /private/tmp/maka-workhub-return-rail/apps/desktop/e2e/workhub-layout.spec.ts:56:65

    attachment #1: screenshot (image/png) ──────────────────────────────────────────────────────────
    e2e/test-results/workhub-layout-WorkHub-use-b1317--shared-attachment-composer/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #2: screenshot (image/png) ──────────────────────────────────────────────────────────
    e2e/test-results/workhub-layout-WorkHub-use-b1317--shared-attachment-composer/test-failed-2.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: e2e/test-results/workhub-layout-WorkHub-use-b1317--shared-attachment-composer/error-context.md

    attachment #4: trace (application/zip) ─────────────────────────────────────────────────────────
    e2e/test-results/workhub-layout-WorkHub-use-b1317--shared-attachment-composer/trace.zip
    Usage:

        npx playwright show-trace e2e/test-results/workhub-layout-WorkHub-use-b1317--shared-attachment-composer/trace.zip

    ────────────────────────────────────────────────────────────────────────────────────────────────


(node:19761) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)


[2/2] e2e/workhub-return-rail.spec.ts:47:1 › WorkHub prompt rail uses the scrollport edge and the shared reading width
  2) e2e/workhub-return-rail.spec.ts:47:1 › WorkHub prompt rail uses the scrollport edge and the shared reading width

    Error: expect(received).toBeLessThanOrEqual(expected)

    Expected: <= 32
    Received:    412

      68 |   expect(geometry.width).toBeGreaterThan(0);
      69 |   expect(geometry.rightInset).toBeGreaterThanOrEqual(10);
    > 70 |   expect(geometry.rightInset).toBeLessThanOrEqual(32);
         |                               ^
      71 |   expect(Math.abs(geometry.rightInset - sessionRail.rightInset)).toBeLessThanOrEqual(1);
      72 |   // Both surfaces apply their shared transcript gutters exactly once.
      73 |   const hubWidth = await workhub.locator('.maka-turn').first().evaluate((element) => element.getBoundingClientRect().width);
        at /private/tmp/maka-workhub-return-rail/apps/desktop/e2e/workhub-return-rail.spec.ts:70:31

    attachment #1: screenshot (image/png) ──────────────────────────────────────────────────────────
    e2e/test-results/workhub-return-rail-WorkHu-bc078-nd-the-shared-reading-width/test-failed-2.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #2: screenshot (image/png) ──────────────────────────────────────────────────────────
    e2e/test-results/workhub-return-rail-WorkHu-bc078-nd-the-shared-reading-width/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: e2e/test-results/workhub-return-rail-WorkHu-bc078-nd-the-shared-reading-width/error-context.md

    attachment #4: trace (application/zip) ─────────────────────────────────────────────────────────
    e2e/test-results/workhub-return-rail-WorkHu-bc078-nd-the-shared-reading-width/trace.zip
    Usage:

        npx playwright show-trace e2e/test-results/workhub-return-rail-WorkHu-bc078-nd-the-shared-reading-width/trace.zip

    ────────────────────────────────────────────────────────────────────────────────────────────────


  2 failed
    e2e/workhub-layout.spec.ts:23:1 › WorkHub uses its coordination model and shared attachment composer
    e2e/workhub-return-rail.spec.ts:47:1 › WorkHub prompt rail uses the scrollport edge and the shared reading width

```
