import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { extractFunctionBlock } from './function-block-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

function blockBetween(source: string, start: string, end: string): string {
  return source.match(new RegExp(`${start}[\\s\\S]*?${end}`))?.[0] ?? '';
}

describe('Plan Reminder panel async action contract', () => {
  // Issue #1044: the create/edit form (all field state + the submit owner)
  // moved into PlanReminderFormDialog; the panel keeps list/runs/query state
  // plus the per-action pending + refresh owners. Each invariant below is
  // asserted against the component that now owns it.
  it('gates form submit and refresh before React commits disabled state', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-panel.tsx'), 'utf8');
    const dialog = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-form-dialog.tsx'), 'utf8');
    const panelBlock = extractFunctionBlock(ui, 'PlanReminderPanel');
    const dialogBlock = extractFunctionBlock(dialog, 'PlanReminderFormDialog');
    const submitBlock = blockBetween(dialogBlock, 'async function submit', 'return \\(');
    const refreshBlock = blockBetween(panelBlock, 'async function refreshFromPanel', 'return \\(');

    assert.match(dialogBlock, /const \[submitPending, setSubmitPending\] = useState\(false\)/);
    assert.match(panelBlock, /const \[refreshPending, setRefreshPending\] = useState\(false\)/);
    assert.match(dialogBlock, /const submitPendingRef = useRef\(false\)/);
    assert.match(panelBlock, /const refreshPendingRef = useRef\(false\)/);
    assert.match(
      dialogBlock,
      /return \(\) => \{\s*submitPendingRef\.current = false;\s*\};\s*\}, \[\]\)/,
      'Plan Reminder pending form owner must be released when the dialog unmounts',
    );
    assert.match(
      panelBlock,
      /return \(\) => \{\s*refreshPendingRef\.current = false;\s*pendingActionKeysRef\.current = new Set\(\);/,
      'Plan Reminder refresh/action pending owners must be released when the panel unmounts',
    );

    assert.match(
      dialogBlock,
      /function closeReminderDialog\(\) \{\s*if \(submitPendingRef\.current\) return;\s*props\.onOpenChange\(false\);/,
      'The form dialog must not close while a submit is still owned by the dialog',
    );
    assert.match(
      submitBlock,
      /event\.preventDefault\(\);\s*if \(submitDisabled \|\| submitPendingRef\.current\) return;\s*submitPendingRef\.current = true;/,
      'Plan Reminder submit must synchronously reject duplicate submits before React disables the submit button',
    );
    assert.match(submitBlock, /setSubmitPending\(true\);/);
    assert.match(
      submitBlock,
      /finally \{\s*submitPendingRef\.current = false;\s*if \(planReminderMountedRef\.current\) setSubmitPending\(false\);/,
      'Plan Reminder submit owner must release without writing React state after unmount',
    );
    assert.match(dialogBlock, /const submitDisabled = !canCreate \|\| submitPending;/);
    assert.match(dialogBlock, /<form className="maka-plan-form" onSubmit=\{submit\} aria-busy=\{submitPending \? 'true' : undefined\}>/);
    assert.match(dialogBlock, /<UiButton type="submit" disabled=\{submitDisabled\}>/);

    assert.match(
      refreshBlock,
      /if \(!props\.onRefresh \|\| refreshPendingRef\.current\) return;\s*refreshPendingRef\.current = true;\s*setRefreshPending\(true\);/,
      'Plan Reminder refresh must synchronously reject duplicate refresh clicks before React disables the icon button',
    );
    assert.match(
      refreshBlock,
      /finally \{\s*refreshPendingRef\.current = false;\s*if \(planReminderMountedRef\.current\) setRefreshPending\(false\);/,
      'Plan Reminder refresh owner must release without writing React state after unmount',
    );
    assert.match(panelBlock, /disabled=\{!props\.onRefresh \|\| refreshPending\}/);
    assert.match(panelBlock, /aria-busy=\{refreshPending \? 'true' : undefined\}/);
  });

  it('keeps the 保持系统唤醒 toggle optimistic, revert-on-error, and unmount-safe', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-panel.tsx'), 'utf8');
    const panelBlock = extractFunctionBlock(ui, 'PlanReminderPanel');
    const toggleBlock = blockBetween(panelBlock, 'async function toggleKeepSystemAwake', 'function openReminderDialog');

    // Pending owner is a ref (sync guard) + React state (disables the switch).
    assert.match(panelBlock, /const \[keepSystemAwakePending, setKeepSystemAwakePending\] = useState\(false\)/);
    assert.match(panelBlock, /const keepSystemAwakePendingRef = useRef\(false\)/);

    // The capability is gated on the host wiring BOTH the value and the setter;
    // otherwise the row hides entirely (fail-soft on an older main / no bridge).
    assert.match(
      panelBlock,
      /const keepSystemAwakeSupported =\s*props\.keepSystemAwake !== undefined && typeof props\.onKeepSystemAwakeChange === 'function';/,
    );
    assert.match(panelBlock, /\{keepSystemAwakeSupported && \(/);

    // The unmount cleanup must also release the keep-awake pending owner so a
    // slow IPC write cannot write state after the panel is gone.
    assert.match(
      panelBlock,
      /refreshPendingRef\.current = false;\s*pendingActionKeysRef\.current = new Set\(\);\s*keepSystemAwakePendingRef\.current = false;/,
      'keep-awake pending owner must be released on unmount alongside the refresh/action owners',
    );

    // Toggle: synchronous duplicate-guard, optimistic flip, localized error
    // toast on failure, mounted-guarded state writes in finally.
    assert.match(
      toggleBlock,
      /if \(!props\.onKeepSystemAwakeChange \|\| keepSystemAwakePendingRef\.current\) return;\s*keepSystemAwakePendingRef\.current = true;/,
      'keep-awake toggle must synchronously reject a duplicate/absent-handler flip before awaiting the write',
    );
    assert.match(toggleBlock, /setKeepSystemAwakeChecked\(next\); \/\/ optimistic/);
    // Revert + toast on failure (asserted individually so an explanatory
    // comment between the catch and the revert does not brittle-break the pin).
    assert.match(toggleBlock, /catch \(error\) \{/);
    assert.match(
      toggleBlock,
      /if \(planReminderMountedRef\.current\) setKeepSystemAwakeChecked\(!next\);/,
      'a failed write must revert the optimistic switch',
    );
    assert.match(
      toggleBlock,
      /toast\.error\(copy\.page\.keepAwakeErrorTitle, locale === 'zh'/,
      'a failed write must surface a locale-aware error toast',
    );
    assert.match(
      toggleBlock,
      /finally \{\s*keepSystemAwakePendingRef\.current = false;\s*if \(planReminderMountedRef\.current\) setKeepSystemAwakePending\(false\);/,
      'keep-awake toggle owner must release without writing React state after unmount',
    );

    // The switch reflects the optimistic state and disables while a write runs.
    assert.match(panelBlock, /checked=\{keepSystemAwakeChecked\}/);
    assert.match(panelBlock, /disabled=\{keepSystemAwakePending\}/);
    assert.match(panelBlock, /onCheckedChange=\{\(next\) => void toggleKeepSystemAwake\(next\)\}/);
  });
});

describe('Plan Reminder management surface contract', () => {
  it('uses scan-friendly rows without hiding recurrence or run state', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-panel.tsx'), 'utf8');
    const css = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/module-pages/plan-reminders.css'),
      'utf8',
    );

    assert.match(ui, /className="maka-plan-list"/);
    assert.doesNotMatch(ui, /agents-dual-card-row/);
    assert.match(ui, /className="maka-plan-card-schedule"/);
    assert.match(ui, /className="maka-plan-card-run"/);

    const listRule = blockBetween(css, '\\.maka-plan-list \\{', '\\}');
    assert.match(listRule, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    const runRule = blockBetween(css, '\\.maka-plan-card-run \\{', '\\}');
    assert.doesNotMatch(runRule, /display:\s*none/);
    assert.doesNotMatch(css, /\.maka-plan-card-chip \+ \.maka-plan-card-chip\s*\{[^}]*display:\s*none/);
  });

  it('shows collection controls only when the current volume justifies them', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-panel.tsx'), 'utf8');

    assert.match(
      ui,
      /const showListControls =\s*props\.reminders\.length >= 8 \|\|\s*normalizedListQuery\.length > 0 \|\|\s*listFilter !== 'all' \|\|\s*listSort !== 'created-desc';/,
    );
    assert.match(
      ui,
      /\{planView === 'tasks' \? \(\s*showListControls \? \([\s\S]*?\) : null\s*\) : \(/,
      'a low-volume task view must render no collection toolbar, not the run-range toolbar',
    );
    assert.match(ui, /useState<PlanReminderListFilter>\('all'\)/);
  });

  it('keeps keep-awake entirely inside contextual page settings', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-panel.tsx'), 'utf8');
    const controller = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/use-keep-system-awake.ts'),
      'utf8',
    );

    assert.match(ui, /<MenuCheckboxItem[\s\S]*checked=\{keepSystemAwakeChecked\}/);
    assert.match(ui, /render=\{<UiButton variant="quiet" size="icon" \/>\}/);
    assert.doesNotMatch(ui, /showKeepAwakeGuidance|keepAwakeHint|keepAwakeOn|maka-plan-awake|maka-plan-system-awake/);
    assert.match(controller, /keepSystemAwake: boolean \| undefined/);
    assert.match(controller, /useState<boolean>\(\)/);
    assert.match(
      controller,
      /catch \{\s*[\s\S]*setSnapshot\(\(previous\) => previous \?\? false\)/,
    );
  });

  it('names row controls with the reminder identity', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-panel.tsx'), 'utf8');

    assert.match(ui, /aria-label=\{`\$\{reminder\.enabled \? copy\.page\.pause : copy\.page\.enable\}: \$\{reminder\.title\}`\}/);
    assert.match(ui, /aria-label=\{`\$\{copy\.page\.reminderActions\}: \$\{reminder\.title\}`\}/);
  });

  it('keeps one create action and a quiet empty explanation', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-panel.tsx'), 'utf8');
    const emptyBranch = blockBetween(ui, 'props.reminders.length === 0 \\? \\(', '\\) : sortedReminders.length');

    assert.match(emptyBranch, /<EmptyState/);
    assert.doesNotMatch(emptyBranch, /BaseButton|openCreateReminderDialog|openPlanReminderTemplate/);
  });

  it('opens the existing form owner for an external create request', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-panel.tsx'), 'utf8');

    assert.match(ui, /createRequestNonce\?: number/);
    assert.match(
      ui,
      /useEffect\(\(\) => \{\s*if \(!props\.createRequestNonce\) return;\s*openReminderDialog\(createPlanReminderFormSeed\(\)\);\s*props\.onCreateRequestHandled\?\.\(\);\s*\}, \[props\.createRequestNonce\]\)/,
    );
  });
});
