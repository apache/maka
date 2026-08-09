import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  AlertDialog,
  Badge,
  Banner,
  Button,
  Card,
  Dialog,
  DialogHeader,
  EmptyState,
  FormLayout,
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  Skeleton,
  Table,
  Text,
  TextInput,
  type BannerStatus,
  type TableColumn,
  type TablePlugin,
  pixel,
  proportional,
} from '@astryxdesign/core';
import type { PricingConfig } from '@maka/core/usage-stats/types';
import type { EffectivePricingEntry, PricingMutation } from '@maka/runtime-host/protocol';
import { useMountedRef, useUiLocale } from '@maka/ui';
import { ICON_SIZE, BarChart3, Plus, RefreshCcw } from '@maka/ui/icons';
import type {
  DesktopPricingSettingsPort,
  DesktopPricingSnapshot,
} from '../../shared/runtime-host-pricing';
import {
  getPricingSettingsCopy,
  type PricingSettingsCopy,
} from '../locales/settings-pricing-copy';
import { settingsActionErrorMessage } from './settings-error-copy';
import {
  createPricingDeleteTarget,
  createPricingDraft,
  decidePricingRecovery,
  findCurrentPricingDeleteTarget,
  formatPricingRate,
  preparePricingDraftForAuthorityReview,
  pricingSnapshotIdentityChanged,
  pricingTargetMatchesSnapshot,
  validatePricingDraft,
  type PricingDraft,
  type PricingDraftField,
  type PricingMutationTarget,
  type PricingRecoveryCause,
  type PricingRecoveryDecision,
  type PricingReviewReason,
} from './pricing-settings-model';
import { PricingSettingsOperationGate } from './pricing-settings-operation-gate';
import { SettingsSection } from './settings-section';

interface EditorSession {
  readonly draft: PricingDraft;
  readonly touched: Readonly<Partial<Record<PricingDraftField, true>>>;
  readonly review?: PricingReviewReason;
}

interface DeleteSession {
  readonly modelKey: string;
  readonly action: 'reset' | 'delete';
  readonly target: Extract<PricingMutationTarget, { kind: 'delete' }>;
  readonly open: boolean;
  readonly review?: PricingReviewReason;
}

interface RecoveryState {
  readonly cause: PricingRecoveryCause;
  readonly target: PricingMutationTarget;
}

interface PricingNotice {
  readonly status: BannerStatus;
  readonly title: string;
  readonly description?: string;
}

type PricingTableRow = Record<string, unknown> & {
  readonly modelKey: string;
  readonly entry: EffectivePricingEntry;
};

const pricingTablePlugins = {
  rowHeader: {
    transformBodyCell: (cell, _column, _row, columnIndex) => columnIndex === 0
      ? { ...cell, htmlProps: { ...cell.htmlProps, role: 'rowheader' } }
      : cell,
  },
} satisfies Record<string, TablePlugin<PricingTableRow>>;

export function PricingSettingsPanel(props: { port: DesktopPricingSettingsPort }) {
  const locale = useUiLocale();
  const copy = getPricingSettingsCopy(locale);
  const mountedRef = useMountedRef();
  const copyRef = useRef(copy);
  const localeRef = useRef(locale);
  copyRef.current = copy;
  localeRef.current = locale;

  const [snapshot, setSnapshot] = useState<DesktopPricingSnapshot | null>(null);
  const snapshotRef = useRef<DesktopPricingSnapshot | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [writePending, setWritePending] = useState(false);
  const [notice, setNotice] = useState<PricingNotice | null>(null);
  const operationGateRef = useRef(new PricingSettingsOperationGate());
  const portRef = useRef(props.port);
  const appliedPortRef = useRef<DesktopPricingSettingsPort | null>(null);
  const authorityReviewPendingRef = useRef(false);
  portRef.current = props.port;

  const [editor, setEditor] = useState<EditorSession | null>(null);
  const editorRef = useRef<EditorSession | null>(null);
  const [deleteSession, setDeleteSession] = useState<DeleteSession | null>(null);
  const deleteSessionRef = useRef<DeleteSession | null>(null);
  const recoveryRef = useRef<RecoveryState | null>(null);

  const addButtonRef = useRef<HTMLButtonElement>(null);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const shouldRestoreFocusRef = useRef(false);

  function replaceSnapshot(next: DesktopPricingSnapshot | null) {
    snapshotRef.current = next;
    setSnapshot(next);
  }

  function replaceEditor(next: EditorSession | null) {
    editorRef.current = next;
    setEditor(next);
  }

  function updateEditor(update: (current: EditorSession) => EditorSession) {
    const current = editorRef.current;
    if (!current) return;
    replaceEditor(update(current));
  }

  function replaceDeleteSession(next: DeleteSession | null) {
    deleteSessionRef.current = next;
    setDeleteSession(next);
  }

  function replaceRecovery(next: RecoveryState | null) {
    recoveryRef.current = next;
  }

  function requestFocusRestore() {
    shouldRestoreFocusRef.current = true;
  }

  useEffect(() => {
    if (!shouldRestoreFocusRef.current || editor !== null || deleteSession?.open) return;
    shouldRestoreFocusRef.current = false;
    const requested = returnFocusRef.current;
    const fallback = addButtonRef.current && !addButtonRef.current.disabled
      ? addButtonRef.current
      : refreshButtonRef.current;
    (requested?.isConnected ? requested : fallback)?.focus();
    returnFocusRef.current = null;
  }, [editor, deleteSession]);

  function reviewEditor(
    reason: PricingReviewReason,
    latest: DesktopPricingSnapshot,
  ): boolean {
    if (!editorRef.current) return false;
    updateEditor((current) => ({
      ...current,
      draft: preparePricingDraftForAuthorityReview(current.draft, latest.entries),
      review: reason,
    }));
    return true;
  }

  function reviewIntent(
    target: PricingMutationTarget,
    reason: PricingReviewReason,
    latest: DesktopPricingSnapshot,
  ): 'review' | 'no_override' | 'missing_intent' {
    if (target.kind === 'upsert') {
      return reviewEditor(reason, latest)
        ? 'review'
        : 'missing_intent';
    }
    const current = deleteSessionRef.current;
    if (!current) return 'missing_intent';
    const nextTarget = findCurrentPricingDeleteTarget(target.modelKey, latest.entries);
    if (!nextTarget) {
      replaceDeleteSession(null);
      requestFocusRestore();
      return 'no_override';
    }
    replaceDeleteSession({
      ...current,
      action: nextTarget.expected === 'builtin' ? 'reset' : 'delete',
      target: nextTarget,
      open: false,
      review: reason,
    });
    return 'review';
  }

  function clearIntent(target: PricingMutationTarget) {
    if (target.kind === 'upsert') replaceEditor(null);
    else replaceDeleteSession(null);
    requestFocusRestore();
  }

  const loadSnapshot = useCallback(async (
    announce: boolean,
    requestedPort: DesktopPricingSettingsPort = portRef.current,
  ) => {
    const gate = operationGateRef.current;
    const operation = gate.begin('read');
    if (!operation) return;
    const previous = snapshotRef.current;
    if (previous === null) setInitialLoading(true);
    setRefreshing(true);
    try {
      const latest = await requestedPort.loadPricingSnapshot();
      if (!mountedRef.current || !gate.isCurrent(operation)) return;
      replaceSnapshot(latest);
      const pendingRecovery = recoveryRef.current;
      if (pendingRecovery) {
        replaceRecovery(null);
        const decision = decidePricingRecovery(
          pendingRecovery.cause,
          pricingTargetMatchesSnapshot(pendingRecovery.target, latest),
        );
        if (decision.kind === 'complete') {
          clearIntent(pendingRecovery.target);
          setNotice({
            status: decision.notice === 'saved' ? 'success' : 'info',
            title: recoveryNoticeTitle(decision.notice, copyRef.current),
          });
        } else {
          const reviewed = reviewIntent(pendingRecovery.target, decision.reason, latest);
          setNotice(reviewed === 'no_override'
            ? { status: 'info', title: copyRef.current.notice.deleteNoLongerApplies }
            : { status: 'warning', title: recoveryNoticeTitle(decision.notice, copyRef.current) });
        }
      } else if (authorityReviewPendingRef.current) {
        authorityReviewPendingRef.current = false;
        const currentEditor = editorRef.current;
        if (currentEditor) {
          reviewEditor('authority_changed', latest);
        }
        const currentDelete = deleteSessionRef.current;
        const deleteReview = currentDelete
          ? reviewIntent(currentDelete.target, 'authority_changed', latest)
          : 'missing_intent';
        setNotice(deleteReview === 'no_override' && !currentEditor
          ? { status: 'info', title: copyRef.current.notice.deleteNoLongerApplies }
          : currentEditor || deleteReview === 'review'
            ? { status: 'warning', title: copyRef.current.notice.refreshedForReview }
            : null);
      } else if (
        previous
        && pricingSnapshotIdentityChanged(previous, latest)
        && (editorRef.current || deleteSessionRef.current)
      ) {
        const currentEditor = editorRef.current;
        if (currentEditor) {
          reviewEditor('authority_changed', latest);
        }
        const currentDelete = deleteSessionRef.current;
        const deleteReview = currentDelete
          ? reviewIntent(currentDelete.target, 'authority_changed', latest)
          : 'missing_intent';
        setNotice(deleteReview === 'no_override' && !currentEditor
          ? { status: 'info', title: copyRef.current.notice.deleteNoLongerApplies }
          : { status: 'warning', title: copyRef.current.notice.refreshedForReview });
      } else if (announce) {
        setNotice({ status: 'success', title: copyRef.current.notice.refreshed });
      } else {
        setNotice(null);
      }
    } catch (error) {
      if (!mountedRef.current || !gate.isCurrent(operation)) return;
      const detail = settingsActionErrorMessage(error, localeRef.current);
      setNotice({
        status: 'error',
        title: copyRef.current.notice.loadFailed,
        description: copyRef.current.notice.loadFailedDescription(detail),
      });
    } finally {
      if (gate.finish(operation) && mountedRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, [mountedRef]);

  useLayoutEffect(() => {
    const replacement = appliedPortRef.current !== null
      && appliedPortRef.current !== props.port;
    appliedPortRef.current = props.port;
    operationGateRef.current.replacePort();
    setRefreshing(false);
    setWritePending(false);
    replaceSnapshot(null);
    replaceRecovery(null);
    if (replacement) {
      const currentEditor = editorRef.current;
      const currentDelete = deleteSessionRef.current;
      if (currentEditor) {
        replaceEditor({ ...currentEditor, review: 'authority_changed' });
      }
      if (currentDelete) {
        replaceDeleteSession({ ...currentDelete, open: false, review: 'authority_changed' });
      }
      authorityReviewPendingRef.current = Boolean(currentEditor || currentDelete);
      setNotice(currentEditor || currentDelete
        ? {
            status: 'warning',
            title: copyRef.current.notice.staleSnapshot,
            description: copyRef.current.notice.staleSnapshotDescription,
          }
        : null);
    } else {
      authorityReviewPendingRef.current = false;
      setNotice(null);
    }
    setInitialLoading(true);
    void loadSnapshot(false, props.port);
  }, [loadSnapshot, props.port]);

  function openEditor(entry: EffectivePricingEntry | undefined, trigger: HTMLButtonElement) {
    if (!snapshotRef.current || operationGateRef.current.activeKind !== null) return;
    returnFocusRef.current = trigger;
    replaceEditor({ draft: createPricingDraft(entry), touched: {} });
  }

  function closeEditor() {
    if (operationGateRef.current.activeKind === 'write') return;
    if (recoveryRef.current?.target.kind === 'upsert') replaceRecovery(null);
    replaceEditor(null);
    setNotice((current) => snapshotRef.current === null && current
      ? { ...current, description: undefined }
      : null);
    requestFocusRestore();
  }

  function openDelete(entry: EffectivePricingEntry, trigger: HTMLButtonElement) {
    if (
      entry.source !== 'custom'
      || !snapshotRef.current
      || operationGateRef.current.activeKind !== null
    ) return;
    const target = createPricingDeleteTarget(entry);
    returnFocusRef.current = trigger;
    replaceDeleteSession({
      modelKey: entry.pricing.modelKey,
      action: target.expected === 'builtin' ? 'reset' : 'delete',
      target,
      open: true,
    });
  }

  function closeDelete() {
    if (operationGateRef.current.activeKind === 'write') return;
    const current = deleteSessionRef.current;
    replaceDeleteSession(null);
    if (current?.review) setNotice(null);
    requestFocusRestore();
  }

  async function applyMutation(target: PricingMutationTarget, mutation: PricingMutation) {
    const base = snapshotRef.current;
    if (!base) return;
    const gate = operationGateRef.current;
    const operation = gate.begin('write');
    if (!operation) return;
    const requestedPort = portRef.current;
    setWritePending(true);
    setNotice(null);
    try {
      const outcome = await requestedPort.applyPricingMutation({ base, mutation });
      if (!mountedRef.current || !gate.isCurrent(operation)) return;
      switch (outcome.kind) {
        case 'saved':
          replaceSnapshot(outcome.snapshot);
          clearIntent(target);
          setNotice({
            status: 'success',
            title: outcome.disposition === 'committed'
              ? copyRef.current.notice.saved
              : copyRef.current.notice.unchanged,
          });
          break;
        case 'saved_refresh_failed':
          replaceSnapshot(null);
          replaceRecovery({ cause: 'known_saved', target });
          if (target.kind === 'delete' && deleteSessionRef.current) {
            replaceDeleteSession({ ...deleteSessionRef.current, open: false });
          }
          setNotice({
            status: 'warning',
            title: copyRef.current.notice.savedRefreshFailed,
            description: copyRef.current.notice.savedRefreshFailedDescription,
          });
          break;
        case 'synchronized':
          replaceSnapshot(outcome.snapshot);
          clearIntent(target);
          setNotice({
            status: 'info',
            title: outcome.reason === 'revision_conflict'
              ? copyRef.current.notice.synchronizedConflict
              : copyRef.current.notice.synchronizedUnknown,
          });
          break;
        case 'review_required':
          replaceSnapshot(outcome.snapshot);
          setNotice(reviewIntent(target, outcome.reason, outcome.snapshot) === 'no_override'
            ? { status: 'info', title: copyRef.current.notice.deleteNoLongerApplies }
            : {
                status: 'warning',
                title: outcome.reason === 'revision_conflict'
                  ? copyRef.current.notice.reviewConflict
                  : copyRef.current.notice.reviewUnknown,
              });
          break;
        case 'reconciliation_unavailable':
          replaceSnapshot(null);
          replaceRecovery({ cause: outcome.reason, target });
          if (target.kind === 'delete' && deleteSessionRef.current) {
            replaceDeleteSession({ ...deleteSessionRef.current, open: false });
          }
          setNotice({
            status: 'warning',
            title: copyRef.current.notice.reconciliationUnavailable,
            description: copyRef.current.notice.reconciliationUnavailableDescription,
          });
          break;
      }
    } catch (error) {
      if (!mountedRef.current || !gate.isCurrent(operation)) return;
      if (runtimeHostErrorCode(error) === 'pricing_snapshot_stale') {
        replaceSnapshot(null);
        replaceRecovery({ cause: 'stale', target });
        if (target.kind === 'delete' && deleteSessionRef.current) {
          replaceDeleteSession({ ...deleteSessionRef.current, open: false });
        }
        setNotice({
          status: 'warning',
          title: copyRef.current.notice.staleSnapshot,
          description: copyRef.current.notice.staleSnapshotDescription,
        });
      } else {
        if (target.kind === 'delete' && deleteSessionRef.current) {
          replaceDeleteSession({ ...deleteSessionRef.current, open: false });
        }
        setNotice({
          status: 'error',
          title: copyRef.current.notice.mutationFailed,
          description: copyRef.current.notice.mutationFailedDescription(
            settingsActionErrorMessage(error, localeRef.current),
          ),
        });
      }
    } finally {
      if (gate.finish(operation) && mountedRef.current) setWritePending(false);
    }
  }

  const entries = snapshot?.entries ?? [];
  const data: PricingTableRow[] = entries.map((entry) => ({
    modelKey: entry.pricing.modelKey,
    entry,
  }));
  const columns: Array<TableColumn<PricingTableRow>> = [
    {
      key: 'modelKey',
      header: copy.headers[0],
      width: proportional(2, { minWidth: 180 }),
      renderCell: (row) => <code className="settingsPricingModelKey">{row.modelKey}</code>,
    },
    {
      key: 'source',
      header: copy.headers[1],
      width: pixel(150),
      renderCell: (row) => <PricingSourceBadge entry={row.entry} copy={copy} />,
    },
    ...(['inputUsdPer1M', 'outputUsdPer1M', 'cacheReadUsdPer1M', 'cacheWriteUsdPer1M'] as const)
      .map((field, index): TableColumn<PricingTableRow> => ({
        key: field,
        header: copy.headers[index + 2],
        align: 'end',
        width: pixel(field.startsWith('cache') ? 112 : 72),
        renderCell: (row) => (
          <span className="settingsPricingRate">
            {rateCell(row.entry.pricing[field], copy)}
          </span>
        ),
      })),
    {
      key: 'actions',
      header: copy.headers[6],
      width: pixel(132),
      resizable: false,
      renderCell: (row) => (
        <HStack gap={1} wrap="wrap">
          <Button
            variant="ghost"
            size="sm"
            label={row.entry.source === 'builtin' ? copy.customize : copy.edit}
            isDisabled={refreshing || writePending || snapshot === null}
            onClick={(event) => openEditor(row.entry, event.currentTarget)}
          />
          {row.entry.source === 'custom' ? (
            <Button
              variant="ghost"
              size="sm"
              label={row.entry.resetEffect === 'restore_builtin' ? copy.reset : copy.delete}
              isDisabled={refreshing || writePending || snapshot === null}
              onClick={(event) => openDelete(row.entry, event.currentTarget)}
            />
          ) : null}
        </HStack>
      ),
    },
  ];

  const recoveryAction = snapshot === null && !initialLoading
    ? (
        <Button
          variant="ghost"
          size="sm"
          label={refreshing ? copy.refreshing : copy.refresh}
          isLoading={refreshing}
          onClick={() => void loadSnapshot(true)}
        />
      )
    : deleteSession && !deleteSession.open && snapshot !== null
      ? (
          <Button
          variant="ghost"
          size="sm"
          label={copy.notice.reviewDelete}
          isDisabled={refreshing || writePending}
          onClick={() => replaceDeleteSession({ ...deleteSession, open: true })}
          />
        )
      : undefined;

  return (
    <div className="settingsPricingPanel">
      <SettingsSection
        title={copy.heading}
        titleId="settings-pricing-heading"
        description={copy.description}
        variant="bare"
        action={(
          <HStack gap={1.5}>
            <Button
              ref={refreshButtonRef}
              variant="ghost"
              size="sm"
              label={refreshing ? copy.refreshing : copy.refresh}
              icon={<RefreshCcw size={ICON_SIZE.control} aria-hidden="true" />}
              isLoading={refreshing}
              isDisabled={initialLoading || writePending}
              onClick={() => void loadSnapshot(true)}
            />
            <Button
              ref={addButtonRef}
              variant="secondary"
              size="sm"
              label={copy.addPrice}
              icon={<Plus size={ICON_SIZE.control} aria-hidden="true" />}
              isDisabled={snapshot === null || refreshing || writePending}
              onClick={(event) => openEditor(undefined, event.currentTarget)}
            />
          </HStack>
        )}
      >
        <div className="settingsPricingContent">
          <Text as="p" type="supporting" size="sm" color="secondary">
            {copy.disclaimer}
          </Text>
          {notice ? (
            <Banner
              status={notice.status}
              title={notice.title}
              description={notice.description}
              endContent={recoveryAction}
            />
          ) : null}
          {initialLoading ? (
            <PricingTableSkeleton label={copy.loading} />
          ) : snapshot === null ? null : data.length === 0 ? (
            <EmptyState
              icon={<BarChart3 size={ICON_SIZE.empty} />}
              title={copy.emptyTitle}
              description={copy.emptyBody}
            />
          ) : (
            <Card className="settingsPricingTable" padding={3}>
              <Table
                aria-label={copy.tableAria}
                data={data}
                columns={columns}
                idKey="modelKey"
                density="compact"
                dividers="rows"
                textOverflow="wrap"
                plugins={pricingTablePlugins}
              />
            </Card>
          )}
        </div>
      </SettingsSection>

      <PricingEditorDialog
        session={editor}
        snapshot={snapshot}
        pending={writePending}
        refreshing={refreshing}
        notice={notice}
        copy={copy}
        onClose={closeEditor}
        onRefresh={() => void loadSnapshot(true)}
        onChange={(field, value) => updateEditor((current) => ({
          ...current,
          draft: { ...current.draft, [field]: value },
          touched: { ...current.touched, [field]: true },
        }))}
        onSave={(pricing) => void applyMutation(
          { kind: 'upsert', pricing },
          { kind: 'upsert', pricing },
        )}
      />

      <PricingDeleteDialog
        session={deleteSession}
        pending={writePending}
        copy={copy}
        onClose={closeDelete}
        onConfirm={() => {
          const current = deleteSessionRef.current;
          if (!current) return;
          void applyMutation(current.target, { kind: 'delete', modelKey: current.modelKey });
        }}
      />
    </div>
  );
}

function PricingTableSkeleton(props: { label: string }) {
  return (
    <Card className="settingsPricingTable" padding={3}>
      {/* Loading (DESIGN.md §10): Pricing has a known table shape, so reserve
          the header plus this surface's typical three ready rows. */}
      <div
        className="settingsPricingTableSkeleton"
        role="status"
        aria-busy="true"
        aria-label={props.label}
      >
        {[0, 1, 2, 3].map((rowIndex) => (
          <div
            key={rowIndex}
            className="settingsPricingTableSkeletonRow"
            aria-hidden="true"
          >
            <Skeleton width="76%" height={rowIndex === 0 ? 10 : 12} radius="rounded" index={rowIndex} />
            <Skeleton width="58%" height={rowIndex === 0 ? 10 : 12} radius="rounded" index={rowIndex + 1} />
            <Skeleton width="64%" height={rowIndex === 0 ? 10 : 12} radius="rounded" index={rowIndex + 2} />
            <Skeleton width="64%" height={rowIndex === 0 ? 10 : 12} radius="rounded" index={rowIndex + 3} />
            <Skeleton width="72%" height={rowIndex === 0 ? 10 : 12} radius="rounded" index={rowIndex + 4} />
            <Skeleton width="72%" height={rowIndex === 0 ? 10 : 12} radius="rounded" index={rowIndex + 5} />
            <Skeleton width="68%" height={rowIndex === 0 ? 10 : 12} radius="rounded" index={rowIndex + 6} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function PricingEditorDialog(props: {
  session: EditorSession | null;
  snapshot: DesktopPricingSnapshot | null;
  pending: boolean;
  refreshing: boolean;
  notice: PricingNotice | null;
  copy: PricingSettingsCopy;
  onClose(): void;
  onRefresh(): void;
  onChange(field: PricingDraftField, value: string): void;
  onSave(pricing: PricingConfig): void;
}) {
  const validation = props.session
    ? validatePricingDraft(props.session.draft, props.snapshot?.entries ?? [])
    : null;
  const interactionDisabled = props.pending || props.refreshing || props.snapshot === null;
  const formId = 'maka-pricing-settings-form';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (interactionDisabled || !validation?.ok) return;
    props.onSave(validation.pricing);
  }

  function fieldStatus(field: PricingDraftField) {
    if (!props.session?.touched[field]) return undefined;
    const error = validation?.errors[field];
    return error
      ? { type: 'error' as const, message: props.copy.validation(field, error) }
      : undefined;
  }

  const latestEntry = props.session && props.snapshot
    ? props.snapshot.entries.find(
        (entry) => entry.pricing.modelKey === props.session?.draft.modelKey.trim(),
      )
    : undefined;
  const dialogNotice = props.notice?.status === 'error'
    ? props.notice
    : props.snapshot === null
      ? props.notice
      : props.session?.review
        ? reviewNotice(props.session.review, props.copy)
        : null;

  return (
    <Dialog
      isOpen={props.session !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      purpose="form"
      width={600}
      maxHeight="calc(100dvh - 32px)"
    >
      <Layout
        height="auto"
        header={props.session ? (
          <DialogHeader
            title={props.session.draft.mode === 'add'
              ? props.copy.editor.addTitle
              : props.copy.editor.editTitle}
            onOpenChange={props.pending ? undefined : (open) => {
              if (!open) props.onClose();
            }}
          />
        ) : undefined}
        content={props.session ? (
          <LayoutContent>
            <form id={formId} onSubmit={submit} aria-busy={props.pending ? 'true' : undefined}>
              <FormLayout>
                {dialogNotice ? (
                  <Banner
                    status={dialogNotice.status}
                    title={dialogNotice.title}
                    description={(
                      <>
                        {dialogNotice.description}
                        {props.session.review ? (
                          <PricingReviewComparison
                            draft={props.session.draft}
                            latest={latestEntry}
                            copy={props.copy}
                          />
                        ) : null}
                      </>
                    )}
                    endContent={props.snapshot === null ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        label={props.refreshing ? props.copy.refreshing : props.copy.refresh}
                        isLoading={props.refreshing}
                        onClick={props.onRefresh}
                      />
                    ) : undefined}
                  />
                ) : null}
                <TextInput
                  label={props.copy.editor.modelKey}
                  description={props.copy.editor.modelKeyDescription}
                  isRequired
                  hasAutoFocus={props.session.draft.mode === 'add'}
                  value={props.session.draft.modelKey}
                  isDisabled={interactionDisabled || props.session.draft.mode === 'edit'}
                  status={fieldStatus('modelKey')}
                  onChange={(value) => props.onChange('modelKey', value)}
                />
                <FormLayout direction="horizontal">
                  <TextInput
                    label={props.copy.editor.inputRate}
                    description={props.copy.editor.rateDescription}
                    isRequired
                    hasAutoFocus={props.session.draft.mode === 'edit'}
                    value={props.session.draft.inputUsdPer1M}
                    isDisabled={interactionDisabled}
                    status={fieldStatus('inputUsdPer1M')}
                    onChange={(value) => props.onChange('inputUsdPer1M', value)}
                  />
                  <TextInput
                    label={props.copy.editor.outputRate}
                    description={props.copy.editor.rateDescription}
                    isRequired
                    value={props.session.draft.outputUsdPer1M}
                    isDisabled={interactionDisabled}
                    status={fieldStatus('outputUsdPer1M')}
                    onChange={(value) => props.onChange('outputUsdPer1M', value)}
                  />
                </FormLayout>
                <FormLayout direction="horizontal">
                  <TextInput
                    label={props.copy.editor.cacheReadRate}
                    description={props.copy.editor.cacheDescription}
                    isOptional
                    value={props.session.draft.cacheReadUsdPer1M}
                    isDisabled={interactionDisabled}
                    status={fieldStatus('cacheReadUsdPer1M')}
                    onChange={(value) => props.onChange('cacheReadUsdPer1M', value)}
                  />
                  <TextInput
                    label={props.copy.editor.cacheWriteRate}
                    description={props.copy.editor.cacheDescription}
                    isOptional
                    value={props.session.draft.cacheWriteUsdPer1M}
                    isDisabled={interactionDisabled}
                    status={fieldStatus('cacheWriteUsdPer1M')}
                    onChange={(value) => props.onChange('cacheWriteUsdPer1M', value)}
                  />
                </FormLayout>
                {props.pending ? (
                  <Text as="p" type="supporting" size="sm" role="status" aria-live="polite">
                    {props.copy.notice.pending}
                  </Text>
                ) : null}
              </FormLayout>
            </form>
          </LayoutContent>
        ) : undefined}
        footer={props.session ? (
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button
                variant="ghost"
                label={props.copy.editor.cancel}
                isDisabled={props.pending}
                onClick={props.onClose}
              />
              <Button
                type="submit"
                form={formId}
                variant="primary"
                label={props.session.review ? props.copy.editor.saveAgain : props.copy.editor.save}
                isLoading={props.pending}
                isDisabled={interactionDisabled || validation?.ok !== true}
              />
            </HStack>
          </LayoutFooter>
        ) : undefined}
      />
    </Dialog>
  );
}

function PricingDeleteDialog(props: {
  session: DeleteSession | null;
  pending: boolean;
  copy: PricingSettingsCopy;
  onClose(): void;
  onConfirm(): void;
}) {
  const session = props.session;
  const consequence = session?.action === 'reset'
    ? props.copy.confirm.resetDescription(session.modelKey)
    : session
      ? props.copy.confirm.deleteDescription(session.modelKey)
      : '';
  const description = session?.review
    ? `${props.copy.confirm.reviewDescription(session.modelKey, session.action)} ${consequence}`
    : consequence;
  return (
    <AlertDialog
      isOpen={session?.open === true}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={session?.action === 'reset'
        ? props.copy.confirm.resetTitle
        : props.copy.confirm.deleteTitle}
      description={description}
      cancelLabel={props.copy.confirm.cancel}
      actionLabel={session?.review
        ? props.copy.confirm.confirmAgain
        : session?.action === 'reset'
          ? props.copy.reset
          : props.copy.delete}
      actionVariant="destructive"
      isActionLoading={props.pending}
      onAction={props.onConfirm}
    />
  );
}

function PricingSourceBadge(props: {
  entry: EffectivePricingEntry;
  copy: PricingSettingsCopy;
}) {
  return (
    <Badge
      variant={props.entry.source === 'builtin'
        ? 'neutral'
        : props.entry.resetEffect === 'restore_builtin'
          ? 'info'
          : 'warning'}
      label={pricingSourceLabel(props.entry, props.copy)}
    />
  );
}

function PricingReviewComparison(props: {
  draft: PricingDraft;
  latest: EffectivePricingEntry | undefined;
  copy: PricingSettingsCopy;
}) {
  return (
    <div className="settingsPricingReviewComparison">
      <div>
        <strong>{props.copy.editor.draftValues}</strong>
        <span>
          {props.copy.headers[1]} {intendedCustomSourceLabel(props.latest, props.copy)} ·{' '}
          {draftSummary(props.draft, props.copy)}
        </span>
      </div>
      <div>
        <strong>{props.copy.editor.latestValues}</strong>
        <span>{props.latest
          ? `${props.copy.headers[1]} ${pricingSourceLabel(props.latest, props.copy)} · ${pricingSummary(props.latest.pricing, props.copy)}`
          : props.copy.editor.latestMissing}</span>
      </div>
    </div>
  );
}

function reviewNotice(reason: PricingReviewReason, copy: PricingSettingsCopy): PricingNotice {
  if (reason === 'revision_conflict') {
    return { status: 'warning', title: copy.notice.reviewConflict };
  }
  if (reason === 'outcome_unknown') {
    return { status: 'warning', title: copy.notice.reviewUnknown };
  }
  return { status: 'warning', title: copy.notice.refreshedForReview };
}

function pricingSourceLabel(
  entry: EffectivePricingEntry,
  copy: PricingSettingsCopy,
): string {
  if (entry.source === 'builtin') return copy.sourceBuiltin;
  return entry.resetEffect === 'restore_builtin'
    ? copy.sourceCustomWithFallback
    : copy.sourceCustomOnly;
}

function intendedCustomSourceLabel(
  latest: EffectivePricingEntry | undefined,
  copy: PricingSettingsCopy,
): string {
  if (!latest) return copy.sourceCustomOnly;
  return latest.source === 'builtin' || latest.resetEffect === 'restore_builtin'
    ? copy.sourceCustomWithFallback
    : copy.sourceCustomOnly;
}

function rateCell(rate: number | undefined, copy: PricingSettingsCopy): ReactNode {
  return rate === undefined ? copy.notSet : formatPricingRate(rate);
}

function pricingSummary(pricing: Readonly<PricingConfig>, copy: PricingSettingsCopy): string {
  return [
    `${copy.headers[2]} ${formatPricingRate(pricing.inputUsdPer1M)}`,
    `${copy.headers[3]} ${formatPricingRate(pricing.outputUsdPer1M)}`,
    `${copy.headers[4]} ${rateCell(pricing.cacheReadUsdPer1M, copy)}`,
    `${copy.headers[5]} ${rateCell(pricing.cacheWriteUsdPer1M, copy)}`,
  ].join(' · ');
}

function draftSummary(draft: PricingDraft, copy: PricingSettingsCopy): string {
  return [
    `${copy.headers[2]} ${draft.inputUsdPer1M}`,
    `${copy.headers[3]} ${draft.outputUsdPer1M}`,
    `${copy.headers[4]} ${draft.cacheReadUsdPer1M || copy.notSet}`,
    `${copy.headers[5]} ${draft.cacheWriteUsdPer1M || copy.notSet}`,
  ].join(' · ');
}

function recoveryNoticeTitle(
  notice: PricingRecoveryDecision['notice'],
  copy: PricingSettingsCopy,
): string {
  if (notice === 'saved') return copy.notice.saved;
  if (notice === 'synchronized_conflict') return copy.notice.synchronizedConflict;
  if (notice === 'synchronized_unknown') return copy.notice.synchronizedUnknown;
  if (notice === 'review_conflict') return copy.notice.reviewConflict;
  if (notice === 'review_unknown') return copy.notice.reviewUnknown;
  return copy.notice.refreshedForReview;
}

function runtimeHostErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
