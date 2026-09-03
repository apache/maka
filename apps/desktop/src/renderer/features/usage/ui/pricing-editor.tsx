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

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { EmptyState, Heading, Skeleton, Text } from '@astryxdesign/core';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Typeahead, createStaticSource, type SearchableItem } from '@astryxdesign/core/Typeahead';
import { Banner, Button, HStack, NumberInput, TextInput, VStack } from '@maka/ui';
import { ICON_SIZE, BarChart3, Pencil, Plus, RefreshCcw, RotateCcw, Search, Trash2 } from '@maka/ui/icons';
import type { PricingSettingsCopy } from '../pricing-copy.js';
import { usePricingController } from '../controller/pricing-controller.js';
import type { UsageHostRef } from '../ports.js';
import type { PricingDraftErrors, PricingRowView } from '../pricing-view-model.js';
import { UsageStatsTable, type UsageColumn } from './usage-stats-table.js';

/** A built-in catalog row as a Typeahead item (its `label` is the model key). */
type CatalogItem = SearchableItem<{ row: PricingRowView }>;

export function PricingEditor(props: {
  readonly describeError: (error: unknown) => string;
  readonly runtimeHost: UsageHostRef | undefined;
  readonly generationKey: string;
}) {
  const c = usePricingController({
    describeError: props.describeError,
    runtimeHost: props.runtimeHost,
    generationKey: props.generationKey,
  });
  const { copy } = c;

  const columns: UsageColumn[] = [
    { header: copy.headers[0], width: 300 },
    { header: copy.headers[1], width: 152 },
    { header: copy.headers[2], numeric: true },
    { header: copy.headers[3], numeric: true },
    { header: copy.headers[4], numeric: true },
    { header: copy.headers[5], numeric: true },
    { header: copy.actionsHeader, width: 104 },
  ];

  // The table shows only the user's overrides (#2015 / #2218 direction). The
  // ~1.4k built-in catalog is never rendered as a table — it is reachable only
  // through the Add flow's Typeahead picker.
  const rows = c.overrideRows.map((row) => [
    row.modelKey,
    pricingSourceLabel(row, copy),
    formatUsd(row.inputUsdPer1M),
    formatUsd(row.outputUsdPer1M),
    formatCache(row.cacheReadUsdPer1M, copy),
    formatCache(row.cacheWriteUsdPer1M, copy),
    <PricingRowActions
      key={row.modelKey}
      row={row}
      copy={copy}
      disabled={c.writesBlocked}
      onEdit={(trigger) => c.openEdit(row, trigger)}
      onReset={(trigger) => c.openReset(row, trigger)}
    />,
  ]);

  return (
    <div className="settingsPricing">
      <div className="settingsPricingHeader">
        <div className="settingsPricingHeading">
          <Heading level={3}>{copy.title}</Heading>
          <Text type="body" color="secondary">{copy.subtitle}</Text>
        </div>
        <HStack gap={2}>
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            isLoading={c.loading}
            label={copy.refresh}
            tooltip={copy.refresh}
            onClick={() => void c.reload()}
            icon={<RefreshCcw size={ICON_SIZE.control} aria-hidden="true" />}
          />
          <Button
            variant="primary"
            size="sm"
            icon={<Plus size={ICON_SIZE.control} aria-hidden="true" />}
            label={copy.add}
            isDisabled={c.writesBlocked || c.loadError !== null}
            tooltip={c.writesBlocked ? copy.writeBlockedReason : undefined}
            onClick={(event) => c.openAdd(event.currentTarget)}
          />
        </HStack>
      </div>

      {/* Panel-level write notice — visible when no editor is open (e.g. a reset
          produced a conflict/uncertain outcome and closed its dialog). */}
      {c.editor === null ? (
        <PricingWriteNotice writeState={c.writeState} latestEntry={c.conflictLatestEntry} copy={copy} />
      ) : null}

      <div aria-live="polite">
        {c.loadError !== null ? (
          <EmptyState
            icon={<BarChart3 />}
            title={copy.loadFailedTitle}
            description={copy.loadFailedBody}
            actions={<Button variant="secondary" size="sm" label={copy.retry} onClick={() => void c.reload()} />}
            className="settingsUsageEmpty"
          />
        ) : c.loading && c.rows.length === 0 ? (
          // Reserve the ready table geometry with skeleton rows so the real
          // rows land with zero layout shift (DESIGN.md §Loading).
          <UsageStatsTable
            ariaLabel={copy.loading}
            columns={columns}
            rows={pricingSkeletonRows(columns.length)}
            empty={{ Icon: BarChart3, title: copy.emptyTitle, body: copy.emptyBody }}
          />
        ) : (
          // After an uncertain/refresh-failed outcome the loaded list may be
          // out of date; dim it and mark it stale until a fresh snapshot loads.
          <div className={c.writesBlocked ? 'settingsPricingStale' : undefined}>
            <UsageStatsTable
              ariaLabel={copy.tableAria}
              columns={columns}
              rows={rows}
              empty={{ Icon: BarChart3, title: copy.emptyTitle, body: copy.emptyBody }}
            />
          </div>
        )}
      </div>

      {c.editor !== null ? <PricingEditorDialog controller={c} /> : null}

      <AlertDialog
        isOpen={c.resetTarget !== null}
        onOpenChange={(open) => {
          if (!open) c.cancelReset();
        }}
        title={c.resetTarget?.resetEffect === 'become_unpriced' ? copy.deleteTitle : copy.resetTitle}
        description={
          c.resetTarget
            ? c.resetTarget.resetEffect === 'become_unpriced'
              ? copy.deleteBody(c.resetTarget.modelKey)
              : copy.resetBody(c.resetTarget.modelKey)
            : ''
        }
        actionLabel={c.resetTarget?.resetEffect === 'become_unpriced' ? copy.confirmDelete : copy.confirmReset}
        cancelLabel={copy.cancel}
        isActionLoading={c.resetBusy}
        onAction={() => void c.confirmReset()}
      />
    </div>
  );
}

function PricingRowActions(props: {
  row: PricingRowView;
  copy: PricingSettingsCopy;
  disabled: boolean;
  onEdit(trigger: HTMLElement | null): void;
  onReset(trigger: HTMLElement | null): void;
}) {
  const { row, copy } = props;
  const secondary = row.source === 'builtin' ? 'none' : row.resetEffect === 'become_unpriced' ? 'delete' : 'reset';
  return (
    <HStack gap={1}>
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        isDisabled={props.disabled}
        label={copy.editAria(row.modelKey)}
        tooltip={copy.edit}
        icon={<Pencil size={ICON_SIZE.control} aria-hidden="true" />}
        onClick={(event) => props.onEdit(event.currentTarget)}
      />
      {secondary === 'none' ? null : (
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          isDisabled={props.disabled}
          label={secondary === 'delete' ? copy.deleteAria(row.modelKey) : copy.resetAria(row.modelKey)}
          tooltip={secondary === 'delete' ? copy.delete : copy.reset}
          icon={
            secondary === 'delete' ? (
              <Trash2 size={ICON_SIZE.control} aria-hidden="true" />
            ) : (
              <RotateCcw size={ICON_SIZE.control} aria-hidden="true" />
            )
          }
          onClick={(event) => props.onReset(event.currentTarget)}
        />
      )}
    </HStack>
  );
}

function PricingEditorDialog(props: {
  controller: ReturnType<typeof usePricingController>;
}) {
  const c = props.controller;
  const { copy, draft, validation, editor } = c;
  const isEdit = editor?.mode === 'edit';
  const title = isEdit ? copy.editTitle : copy.addTitle;
  // Show field errors only after a save attempt so a fresh Add form is quiet.
  const [attempted, setAttempted] = useState(false);
  // Add flow: pick a model from the built-in catalog (Typeahead, pre-fills the
  // built-in price) or fall back to typing an arbitrary key for a model not in
  // the catalog (local/new models). Reset both when the editor (re)opens.
  const [addMode, setAddMode] = useState<'catalog' | 'manual'>('catalog');
  const [picked, setPicked] = useState<CatalogItem | null>(null);
  useEffect(() => {
    setAttempted(false);
    setAddMode('catalog');
    setPicked(null);
  }, [editor]);

  const catalogSource = useMemo(
    () =>
      createStaticSource<CatalogItem>(
        c.catalogRows.map((row) => ({ id: row.modelKey, label: row.modelKey, auxiliaryData: { row } })),
      ),
    [c.catalogRows],
  );

  function close() {
    if (!c.saving) c.closeEditor();
  }
  function submit() {
    setAttempted(true);
    void c.save();
  }
  const fieldStatus = (message: string | undefined) =>
    attempted && message ? ({ type: 'error' as const, message }) : undefined;
  const errorMessage = (code: PricingDraftErrors[keyof PricingDraftErrors]): string | undefined =>
    code === undefined
      ? undefined
      : code === 'required'
        ? copy.errorRequired
        : code === 'invalid_rate'
          ? copy.errorInvalidRate
          : code === 'key_too_long'
            ? copy.errorKeyTooLong
            : copy.errorDuplicate;

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
      aria-label={title}
      purpose="form"
      width={480}
      maxHeight="calc(100dvh - 64px)"
    >
      <Layout
        header={<DialogHeader title={title} onOpenChange={(open) => { if (!open) close(); }} />}
        content={
          <LayoutContent padding={4}>
            <VStack as="form" gap={3} onSubmit={(event) => { event.preventDefault(); submit(); }}>
              {isEdit ? (
                // Editing an existing override: the key is fixed, shown read-only.
                <>
                  <TextInput
                    value={draft.provider}
                    onChange={(value) => c.setField('provider', value)}
                    label={copy.providerLabel}
                    isReadOnly
                    width="100%"
                  />
                  <TextInput
                    value={draft.model}
                    onChange={(value) => c.setField('model', value)}
                    label={copy.modelLabel}
                    isReadOnly
                    width="100%"
                  />
                </>
              ) : addMode === 'catalog' ? (
                // Add via the built-in catalog: Typeahead renders only the top
                // matches (never the ~1.4k-row list), and a pick pre-fills the
                // built-in price. Its `value.label` is the model key it commits.
                <VStack gap={1}>
                  <Typeahead<CatalogItem>
                    label={copy.catalogPickerLabel}
                    searchSource={catalogSource}
                    value={picked}
                    onChange={(item) => {
                      setPicked(item);
                      if (item) {
                        c.pickCatalogModel(item.auxiliaryData!.row);
                      } else {
                        c.setField('provider', '');
                        c.setField('model', '');
                      }
                    }}
                    placeholder={copy.catalogPickerPlaceholder}
                    emptySearchResultsText={copy.catalogEmptyResults}
                    startIcon={<Search size={ICON_SIZE.control} aria-hidden="true" />}
                    minQueryLength={1}
                    debounceMs={0}
                    maxMenuItems={12}
                    hasClear
                    width="100%"
                    status={fieldStatus(errorMessage(validation.errors.model))}
                  />
                  {picked ? (
                    <Text type="supporting" color="secondary">{copy.builtinPrefillHint}</Text>
                  ) : null}
                  <HStack justify="end">
                    <Button
                      variant="ghost"
                      size="sm"
                      label={copy.manualEntryToggle}
                      onClick={() => {
                        setPicked(null);
                        c.setField('provider', '');
                        c.setField('model', '');
                        setAddMode('manual');
                      }}
                    />
                  </HStack>
                </VStack>
              ) : (
                // Manual fallback: an arbitrary key for a model not in the catalog.
                <VStack gap={1}>
                  <TextInput
                    value={draft.provider}
                    onChange={(value) => c.setField('provider', value)}
                    label={copy.providerLabel}
                    placeholder={copy.providerPlaceholder}
                    isRequired
                    hasAutoFocus
                    width="100%"
                    status={fieldStatus(errorMessage(validation.errors.provider))}
                  />
                  <TextInput
                    value={draft.model}
                    onChange={(value) => c.setField('model', value)}
                    label={copy.modelLabel}
                    placeholder={copy.modelPlaceholder}
                    description={copy.keyHelp}
                    isRequired
                    width="100%"
                    status={fieldStatus(errorMessage(validation.errors.model))}
                  />
                  <HStack justify="end">
                    <Button
                      variant="ghost"
                      size="sm"
                      label={copy.catalogToggle}
                      onClick={() => setAddMode('catalog')}
                    />
                  </HStack>
                </VStack>
              )}
              <NumberInput
                value={draft.input}
                onChange={(value) => c.setField('input', value)}
                label={copy.inputLabel}
                description={copy.rateHelp}
                min={0}
                step={0.01}
                hasClear
                isRequired
                width="100%"
                status={fieldStatus(errorMessage(validation.errors.input))}
              />
              <NumberInput
                value={draft.output}
                onChange={(value) => c.setField('output', value)}
                label={copy.outputLabel}
                min={0}
                step={0.01}
                hasClear
                isRequired
                width="100%"
                status={fieldStatus(errorMessage(validation.errors.output))}
              />
              <Collapsible
                trigger={copy.cacheSection}
                isOpen={c.cacheOpen}
                onOpenChange={c.setCacheOpen}
              >
                <VStack gap={3}>
                  <NumberInput
                    value={draft.cacheRead}
                    onChange={(value) => c.setField('cacheRead', value)}
                    label={copy.cacheReadLabel}
                    description={copy.cacheHelp}
                    min={0}
                    step={0.01}
                    hasClear
                    isOptional
                    width="100%"
                    status={fieldStatus(errorMessage(validation.errors.cacheRead))}
                  />
                  <NumberInput
                    value={draft.cacheWrite}
                    onChange={(value) => c.setField('cacheWrite', value)}
                    label={copy.cacheWriteLabel}
                    min={0}
                    step={0.01}
                    hasClear
                    isOptional
                    width="100%"
                    status={fieldStatus(errorMessage(validation.errors.cacheWrite))}
                  />
                </VStack>
              </Collapsible>
              <PricingWriteNotice writeState={c.writeState} latestEntry={c.conflictLatestEntry} copy={copy} />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button variant="ghost" label={copy.cancel} isDisabled={c.saving} onClick={close} />
              <Button
                variant="primary"
                label={c.writeState.kind === 'conflict' ? copy.reviewSave : copy.save}
                isLoading={c.saving}
                isDisabled={c.saving || c.writesBlocked}
                tooltip={c.writesBlocked ? copy.writeBlockedReason : undefined}
                onClick={submit}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

function PricingWriteNotice(props: {
  writeState: ReturnType<typeof usePricingController>['writeState'];
  latestEntry: PricingRowView | null;
  copy: PricingSettingsCopy;
}) {
  const { writeState, latestEntry, copy } = props;
  switch (writeState.kind) {
    case 'conflict': {
      // An `outcome_unknown` conflict is uncertain, not a confirmed external
      // change — it must not be described as one.
      const uncertain = writeState.reason === 'outcome_unknown';
      const latest = latestEntry
        ? ` ${copy.conflictLatest(formatUsd(latestEntry.inputUsdPer1M), formatUsd(latestEntry.outputUsdPer1M))}`
        : '';
      return (
        <Banner
          status="warning"
          role="status"
          title={uncertain ? copy.conflictTitleUnknown : copy.conflictTitle}
          description={`${uncertain ? copy.conflictBodyUnknown : copy.conflictBody}${latest}`}
        />
      );
    }
    case 'refresh_failed':
      return <Banner status="warning" role="status" title={copy.refreshFailedTitle} description={copy.refreshFailedBody} />;
    case 'reconcile_unavailable':
      return <Banner status="warning" role="status" title={copy.reconcileTitle} description={copy.reconcileBody} />;
    case 'idle':
      return null;
  }
}

/** Skeleton rows that mirror the real table's column count for a zero-shift load.
 *  Height 16 (a DESIGN.md-allowed bar height) and a small row count matching the
 *  overrides surface's typical ready state (a handful of custom rows). */
function pricingSkeletonRows(columnCount: number): Array<Array<ReactNode>> {
  return Array.from({ length: 3 }, () =>
    Array.from({ length: columnCount }, (_unused, column) => (
      <Skeleton key={column} width={column === 0 ? '60%' : '40%'} height={16} index={column} />
    )),
  );
}

function pricingSourceLabel(row: PricingRowView, copy: PricingSettingsCopy): string {
  if (row.source === 'builtin') return copy.sourceBuiltin;
  return row.resetEffect === 'restore_builtin' ? copy.sourceCustomFallback : copy.sourceCustomOnly;
}

// Display formatting must round-trip the canonical value without losing
// precision, and a positive rate must never render as `$0` (#2015). Raw
// interpolation uses JS shortest-round-trip `Number.toString`, so `2.5` stays
// `$2.5` and `0.075` stays `$0.075` — never `.toFixed`-collapsed to `$0`.
export function formatUsd(value: number): string {
  return `$${value}`;
}

// An omitted cache rate ("not set", no cache charge) stays distinct from an
// explicit `0` (#2015): only `undefined` maps to the not-set copy.
export function formatCache(value: number | undefined, copy: PricingSettingsCopy): string {
  return value === undefined ? copy.cacheNotSet : `$${value}`;
}
