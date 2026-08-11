import type { LocalMemoryState } from '@maka/core/local-memory';
import { EmptyState } from '@astryxdesign/core';
import { Button, MoreMenu, RelativeTime } from '@maka/ui';
import { memoryOriginLabel } from './memory-settings-labels';
import type { MemorySettingsCopy } from '../locales/settings-memory-copy';

export function MemoryEntryList(props: {
  title: string;
  copy: MemorySettingsCopy;
  entries: LocalMemoryState['activeEntries'];
  filtered?: boolean;
  archived?: boolean;
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
      {props.entries.length === 0 ? (
        <EmptyState
          isCompact
          className="settingsMemoryEntryEmpty"
          title={props.filtered ? props.copy.text.noMatchEntry : props.copy.text.noEntry}
        />
      ) : (
        <ul className="settingsMemoryEntryList" aria-label={props.copy.listAria(props.title)}>
          {props.entries.map((entry) => {
            const copyPending = props.pendingCopyIds?.has(`entry:${entry.id}:copy`) ?? false;
            const statusActionLabel = props.archived
              ? props.copy.text.restoreAction
              : props.copy.text.archiveAction;
            return (
              <li key={entry.id}>
                <article className="settingsMemoryEntryRow">
                <strong>{entry.title}</strong>
                <small className="settingsMemoryEntryMeta">
                  {memoryOriginLabel(entry.origin, props.copy)}
                  {entry.tags.length > 0 ? ` · ${entry.tags.join(' / ')}` : ''}
                </small>
                <small className="settingsMemoryEntryFacts">
                  {entry.updatedAt !== undefined && (
                    <span>
                      {props.copy.text.updated}<RelativeTime ts={entry.updatedAt} />
                    </span>
                  )}
                </small>
                <p>{entry.content}</p>
                {(props.onCopyReference || props.onFocusDraft || props.onStatusChange) && (
                  <div className="settingsMemoryEntryActions" role="group" aria-label={props.copy.entryActionsAria(entry.title)}>
                    {props.onStatusChange && (
                      <Button
                        variant="ghost"
                        size="sm"
                        isDisabled={props.busy}
                        onClick={() => void props.onStatusChange?.(entry, props.archived ? 'active' : 'archived')}
                        label={statusActionLabel}
                      />
                    )}
                    {(props.onCopyReference || props.onFocusDraft) && (
                      <MoreMenu
                        label={props.copy.entryActionsAria(entry.title)}
                        size="sm"
                        items={[
                          ...(props.onCopyReference
                            ? [{
                                label: copyPending ? props.copy.text.copying : props.copy.text.copyReference,
                                isDisabled: copyPending,
                                onClick: () => void props.onCopyReference?.(entry),
                              }]
                            : []),
                          ...(props.onFocusDraft
                            ? [{
                                label: props.copy.text.locateDraft,
                                onClick: () => void props.onFocusDraft?.(entry),
                              }]
                            : []),
                        ]}
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
