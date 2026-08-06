import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectRecord } from '@maka/core';
import { LocaleProvider } from '../locale-context.js';
import { Composer } from '../composer.js';
import { WorkspacePicker } from '../workspace-picker.js';

const catalog = [
  { id: 'project-a', name: 'Alpha', locations: [{ path: '/a', isWorktree: false }], available: true },
  { id: 'project-b', name: 'Beta', locations: [{ path: '/b', isWorktree: false }], available: true },
  { id: 'project-c', name: 'Gamma', locations: [{ path: '/old', isWorktree: false }], available: false },
] satisfies readonly ProjectRecord[];

function renderPicker(props: {
  pending?: boolean;
  selectedProjectId?: string | null;
  projects?: readonly ProjectRecord[];
}): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <WorkspacePicker
        workspacePicker={{
          label: 'Alpha',
          pending: props.pending,
          projects: props.projects ?? catalog,
          selectedProjectId: props.selectedProjectId ?? 'project-a',
          onAdd: () => undefined,
          onSelectProject: () => undefined,
          onRelink: () => undefined,
          onSelectNoProject: () => undefined,
        }}
      />
    </LocaleProvider>,
  );
}

/**
 * The project is a session-creation parameter: it decides where a NEW chat
 * starts and is fixed once the first message creates the session. So the host
 * passes the picker unconditionally and the composer owns the gate — these
 * assertions pin that lifetime, not the placement.
 */
describe('Composer workspace picker', () => {
  const workspacePicker = {
    label: 'maka-agent',
    projects: [],
    onAdd: () => undefined,
    onSelectProject: () => undefined,
    onRelink: () => undefined,
    onSelectNoProject: () => undefined,
  };

  const activeSession = {
    id: 'session-1',
    name: 'Test',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'done' as const,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake',
    permissionMode: 'ask' as const,
  };

  function render(props: { activeSession?: typeof activeSession }): string {
    return renderToStaticMarkup(
      <LocaleProvider locale="en">
        <Composer
          onSend={() => true}
          onStop={() => {}}
          modelLabel="demo-model"
          modelChoices={[]}
          activeSession={props.activeSession}
          workspacePicker={workspacePicker}
        />
      </LocaleProvider>,
    );
  }

  /**
   * Containment and order, not mere presence: the placement is what this
   * control has churned on — a bar of its own above the card, the empty-chat
   * hero, a composer header row — and each of those renders the same classes
   * somewhere in the markup. Only the footer group puts it beside the other
   * parameters of this send, where losing it on the first message moves
   * nothing to its left.
   */
  it('renders the picker in the footer controls, after the model group', () => {
    const markup = render({});

    const leftControls = markup.match(
      /maka-composer-left-controls[\s\S]*?maka-composer-right-controls/,
    )?.[0] ?? '';
    assert.match(leftControls, /maka-composer-workspace/, 'picker rides the footer row');
    assert.match(leftControls, /maka-workspace-picker/);

    const modelIdx = leftControls.indexOf('maka-model-selection-controls');
    const pickerIdx = leftControls.indexOf('maka-composer-workspace');
    assert.ok(modelIdx >= 0 && pickerIdx > modelIdx, 'picker follows the model pair');

    // The trigger is a ghost button opening a menu — the footer toolbar
    // family (model, thinking, ＋, permission) — not a combobox field. That
    // family is what carries the tooltip and the Button focus ring the
    // Selector this replaced had no slots for.
    const pickerTrigger = leftControls.match(/<button[^>]*maka-workspace-picker[^>]*>/)?.[0] ?? '';
    assert.match(pickerTrigger, /aria-haspopup="menu"/, 'picker trigger opens a menu, not a listbox');
  });

  it('drops it once a session owns the composer, even though the host still passes it', () => {
    const markup = render({ activeSession });

    assert.doesNotMatch(markup, /maka-composer-workspace/);
    assert.doesNotMatch(markup, /maka-workspace-picker/);
  });

  /**
   * The open menu's structure — one catalogue in its own scroll region, the
   * two actions after it in normal flow — is the fix for the reported "the
   * pinned actions scroll along" bug. Mid-PR this tree accidentally rendered
   * TWO copies of the catalogue, which made keyboard roving unreachable and
   * wrapped back to the first row; the CSS contract cannot see the
   * duplication, so the single-copy tree is pinned here.
   */
  it('renders the catalogue exactly once, in its own region, actions after it', () => {
    const markup = renderPicker({});

    const scrollRegions = markup.match(/maka-workspace-picker-scroll/g) ?? [];
    assert.equal(scrollRegions.length, 1, 'one catalogue region; a second copy made roving unreachable');

    const scrollIdx = markup.indexOf('maka-workspace-picker-scroll');
    const groupIdx = markup.indexOf('role="group"');
    assert.ok(scrollIdx >= 0 && groupIdx > scrollIdx, 'the actions sit after the catalogue, outside the scroller');

    assert.match(
      markup,
      /Gamma[\s\S]*?maka-workspace-picker-status/,
      'an unavailable project offers relink on its row',
    );

    const checks = markup.match(/lucide-check/g) ?? [];
    assert.equal(checks.length, 1, 'exactly the current project wears the check');
  });

  it('wears the check on the no-project row when no project is selected', () => {
    const markup = renderPicker({ selectedProjectId: null });

    const checks = markup.match(/lucide-check/g) ?? [];
    assert.equal(checks.length, 1, 'exactly one current-value check');

    const noProjectRow = markup.match(
      /<div\b[^>]*role="menuitem"[^>]*>[\s\S]*?No project[\s\S]*?<\/div>/,
    )?.[0] ?? '';
    assert.match(noProjectRow, /lucide-check/, 'the no-project row carries the current-value check');
  });

  it('renders no scroll region on first run, the actions as the menu\'s first child', () => {
    const markup = renderPicker({ projects: [] });

    assert.doesNotMatch(markup, /maka-workspace-picker-scroll/);
    assert.match(markup, /role="menu"/, 'the menu still renders');
    const groupIdx = markup.indexOf('role="group"');
    assert.ok(groupIdx > 0, 'the actions group renders');
  });

  it('locks the trigger and every row while a switch is pending', () => {
    // An aria-disabled trigger still opens its menu on ArrowDown (Astryx
    // DropdownMenu's keydown path does not consult isDisabled), so a lock
    // that lived only on the trigger would be bypassable by keyboard — the
    // same reason the model switcher locks its rows (#2230).
    const markup = renderPicker({ pending: true });

    const trigger = markup.match(/<button[^>]*maka-workspace-picker[^>]*>/)?.[0] ?? '';
    assert.match(trigger, /aria-disabled="true"/, 'the trigger is inert while pending');
    assert.match(trigger, /aria-busy="true"/, 'the trigger carries the loading marker');

    const items = markup.match(/<div\b[^>]*role="menuitem"[^>]*>/g) ?? [];
    assert.ok(items.length >= 4, 'catalogue rows and both actions render');
    assert.ok(
      items.every((tag) => tag.includes('aria-disabled="true"')),
      'every menu row is inert while pending',
    );
  });

  it('leaves the rows enabled at rest', () => {
    const markup = renderPicker({});

    const items = markup.match(/<div\b[^>]*role="menuitem"[^>]*>/g) ?? [];
    assert.ok(items.length >= 4, 'catalogue rows and both actions render');
    assert.ok(items.every((tag) => !tag.includes('aria-disabled="true"')), 'rows are enabled at rest');
  });
});
