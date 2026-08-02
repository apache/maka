import type { LocalMemoryState } from '@maka/core';
import { Badge, Button, RelativeTime } from '@maka/ui';
import { memoryOriginLabel } from './memory-settings-labels';
import type { MemorySettingsCopy } from '../locales/settings-memory-copy';

export function MemoryEntryList(props: {
  title: string;
  copy: MemorySettingsCopy;
  entries: LocalMemoryState['activeEntries'];
  filtered?: boolean;
  archived?: boolean;
  draftDirty?: boolean;
  busy?: boolean;
  pendingCopyIds?: ReadonlySet<string>;
  onCopyReference?(entry: LocalMemoryState['activeEntries'][number]): void | Promise<void>;
  onFocusDraft?(entry: LocalMemoryState['activeEntries'][number]): void | Promise<void>;
  onStatusChange?(entry: LocalMemoryState['activeEntries'][number], status: 'active' | 'archived'): void | Promise<void>;
}) {
  return (
    <section className="settingsMemoryEntryGroup" data-archived={props.archived ? 'true' : 'false'}>
      <div className="settingsMemoryEntryGroupHeader">
        <strong>{props.title}</strong>
        <span>{props.copy.countEntries(props.entries.length)}</span>
      </div>
      {props.draftDirty && props.onStatusChange && (
        <p className="settingsMemoryEntryDraftNotice" role="status">
          {props.copy.text.archiveDraftNotice}
        </p>
      )}
      {props.entries.length === 0 ? (
        <p className="settingsMemoryEntryEmpty">{props.filtered ? props.copy.text.noMatchEntry : props.copy.text.noEntry}</p>
      ) : (
        /* PR-MEMORY-ENTRY-LIST-A11Y-0 (round 18/30): fourth
           application of the same ARIA list fix. Was `<div
           role="list">` with `<article role="listitem">` rows —
           semantic `<ul>` / `<li>` so screen readers get the
           relationship from the elements themselves. The inner
           `<article>` per entry stays — articles are valid
           sectioning content inside list items. */
        <ul className="settingsMemoryEntryList" aria-label={props.copy.listAria(props.title)}>
          {props.entries.map((entry) => {
            const copyPending = props.pendingCopyIds?.has(`entry:${entry.id}:copy`) ?? false;
            const statusActionLabel = props.draftDirty
              ? props.archived
                ? props.copy.text.restoreDraftAction
                : props.copy.text.archiveDraftAction
              : props.archived
                ? props.copy.text.restoreAction
                : props.copy.text.archiveAction;
            const statusActionAriaLabel = props.draftDirty
              ? props.copy.draftStatusAria(statusActionLabel)
              : undefined;
            return (
              <li key={entry.id}>
                <article className="settingsMemoryEntryCard">
                <strong>{entry.title}</strong>
                <small className="settingsMemoryEntryMeta">
                  {memoryOriginLabel(entry.origin, props.copy)}
                  {entry.tags.length > 0 ? ` · ${entry.tags.join(' / ')}` : ''}
                </small>
                <small className="settingsMemoryEntryFacts">
                  <span>ID {entry.id}</span>
                  {entry.createdAt !== undefined && (
                    <span>
                      {props.copy.text.created}<RelativeTime ts={entry.createdAt} className="settingsHelpInlineTime" />
                    </span>
                  )}
                  {entry.updatedAt !== undefined && (
                    <span>
                      {props.copy.text.updated}<RelativeTime ts={entry.updatedAt} className="settingsHelpInlineTime" />
                    </span>
                  )}
                </small>
                <Badge
                  className="settingsMemoryPromptScope"
                  /* `blue`, not `info`: Astryx's semantic archive is solid
                     fills and its colour archive is tints, and the wash this
                     replaced was `--state-selected-bg`. */
                  variant={props.archived ? 'neutral' : 'blue'}
                  label={props.archived ? props.copy.text.archivedNoPrompt : props.copy.text.activePrompt}
                />
                <p>{entry.content}</p>
                {(props.onCopyReference || props.onFocusDraft || props.onStatusChange) && (
                  <div className="settingsMemoryEntryActions" role="group" aria-label={props.copy.entryActionsAria(entry.title)}>
                    {props.onCopyReference && (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="settingsActionWidthSm"
                        isDisabled={copyPending}
                        onClick={() => void props.onCopyReference?.(entry)}
                        label={copyPending ? props.copy.text.copying : props.copy.text.copyReference}
                      />
                    )}
                    {props.onFocusDraft && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void props.onFocusDraft?.(entry)}
                        label={props.copy.text.locateDraft}
                      />
                    )}
                    {props.onStatusChange && (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="settingsActionWidthMd"
                        aria-label={statusActionAriaLabel}
                        isDisabled={props.busy}
                        onClick={() => void props.onStatusChange?.(entry, props.archived ? 'active' : 'archived')}
                        label={statusActionLabel}
                      />
                    )}
                  </div>
                )}
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
