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

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { EmptyState, Heading, Skeleton, Text } from '@astryxdesign/core';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Typeahead, createStaticSource, type SearchableItem } from '@astryxdesign/core/Typeahead';
import { Banner, Button, HStack, NumberInput, TextInput, VStack } from '@maka/ui';
import { ICON_SIZE, BarChart3, Pencil, Plus, RefreshCcw, RotateCcw, Search, Trash2 } from '@maka/ui/icons';
import type { PricingSettingsCopy } from '../../../locales/settings-pricing-copy.js';
import { usePricingController } from '../controller/pricing-controller.js';
import type { UsagePricingTarget } from '../pricing-ports.js';
import type { PricingDraftErrors, PricingRowView } from '../pricing-view-model.js';
import { UsageStatsTable, type UsageColumn } from './usage-stats-table.js';

/** A built-in catalog row as a Typeahead item (its `label` is the model key). */
type CatalogItem = SearchableItem<{ row: PricingRowView }>;

export function PricingEditor(props: {
  readonly describeError: (error: unknown) => string;
  readonly target: UsagePricingTarget | null;
}) {
  const c = usePricingController({
    describeError: props.describeError,
    target: props.target,
  });
  const { copy } = c;
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const columns: UsageColumn[] = [
    { header: copy.headers[0], width: 300 },
    { header: copy.headers[1], width: 152 },
    // Rate columns carry a "… / 1M" header; the shared table's default numeric
    // width (88) truncates the wider ones (esp. the cache headers, and even more
    // so in English: "Cache read / 1M" / "Cache write / 1M"). Size each to show
    // its full header — the panel is wide enough that this adds no scroll.
    { header: copy.headers[2], numeric: true, width: 116 },
    { header: copy.headers[3], numeric: true, width: 116 },
    { header: copy.headers[4], numeric: true, width: 140 },
    { header: copy.headers[5], numeric: true, width: 140 },
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
      onReset={(trigger) => c.openReset(row, trigger, addButtonRef.current)}
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
            ref={addButtonRef}
            variant="primary"
            size="sm"
            icon={<Plus size={ICON_SIZE.control} aria-hidden="true" />}
            label={copy.add}
            isDisabled={c.writesBlocked || c.loadError !== null || !c.hasAuthority}
            tooltip={
              c.writesBlocked
                ? copy.writeBlockedReason
                : !c.hasAuthority
                  ? copy.addNeedsSnapshot
                  : undefined
            }
            onClick={(event) => c.openAdd(event.currentTarget)}
          />
        </HStack>
      </div>

      {/* Keep notices inside whichever modal owns the pending intent. The panel
          notice is only for a blocked state with no open editor/reset dialog. */}
      {c.editor === null && c.resetTarget === null ? (
        <PricingWriteNotice
          writeState={c.writeState}
          latestEntry={c.conflictLatestEntry}
          copy={copy}
          onRefresh={() => void c.reload()}
          refreshBusy={c.loading}
        />
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
        ) : c.loading && c.overrideRows.length === 0 ? (
          // Reserve the ready table geometry with skeleton rows so the real
          // rows land with zero layout shift (DESIGN.md §Loading).
          <UsageStatsTable
            ariaLabel={copy.loading}
            columns={columns}
            rows={pricingSkeletonRows(columns.length)}
            empty={{ Icon: BarChart3, title: copy.emptyTitle, body: copy.emptyBody }}
          />
        ) : (
          <UsageStatsTable
            ariaLabel={copy.tableAria}
            columns={columns}
            rows={rows}
            empty={{ Icon: BarChart3, title: copy.emptyTitle, body: copy.emptyBody }}
          />
        )}
      </div>

      {c.editor !== null ? <PricingEditorDialog controller={c} /> : null}

      {c.resetTarget !== null ? <PricingResetDialog controller={c} /> : null}
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
  // Every rendered row is a user override (overrides-only surface): a
  // `restore_builtin` row can be reset to its bundled price, a `become_unpriced`
  // row can only be deleted (Custom-only).
  const isDelete = row.resetEffect === 'become_unpriced';
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
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        isDisabled={props.disabled}
        label={isDelete ? copy.deleteAria(row.modelKey) : copy.resetAria(row.modelKey)}
        tooltip={isDelete ? copy.delete : copy.reset}
        icon={
          isDelete ? (
            <Trash2 size={ICON_SIZE.control} aria-hidden="true" />
          ) : (
            <RotateCcw size={ICON_SIZE.control} aria-hidden="true" />
          )
        }
        onClick={(event) => props.onReset(event.currentTarget)}
      />
    </HStack>
  );
}

function PricingResetDialog(props: {
  controller: ReturnType<typeof usePricingController>;
}) {
  const c = props.controller;
  const { copy, resetTarget } = c;
  const descriptionId = useId();
  if (resetTarget === null) return null;
  const isDelete = resetTarget.resetEffect === 'become_unpriced';
  const hasConflict = c.writeState.kind === 'conflict';

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) c.cancelReset();
      }}
      role="alertdialog"
      aria-describedby={descriptionId}
      purpose="form"
      width={400}
    >
      <Layout
        header={<DialogHeader title={isDelete ? copy.deleteTitle : copy.resetTitle} />}
        content={
          <LayoutContent padding={4}>
            <VStack gap={3}>
              <Text id={descriptionId} type="body" color="secondary">
                {isDelete ? copy.deleteBody(resetTarget.modelKey) : copy.resetBody(resetTarget.modelKey)}
              </Text>
              <PricingWriteNotice
                writeState={c.writeState}
                latestEntry={c.conflictLatestEntry}
                copy={copy}
                onRefresh={() => void c.reload()}
                refreshBusy={c.loading}
              />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button
                variant="ghost"
                label={copy.cancel}
                isDisabled={c.resetBusy}
                onClick={c.cancelReset}
                data-autofocus
              />
              <Button
                variant="destructive"
                label={
                  hasConflict
                    ? isDelete
                      ? copy.reviewDelete
                      : copy.reviewReset
                    : isDelete
                      ? copy.confirmDelete
                      : copy.confirmReset
                }
                isLoading={c.resetBusy}
                isDisabled={c.writesBlocked}
                tooltip={c.writesBlocked ? copy.writeBlockedReason : undefined}
                onClick={() => void c.confirmReset()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
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
                <TextInput
                  value={draft.modelKey}
                  onChange={(value) => c.setField('modelKey', value)}
                  label={copy.modelKeyLabel}
                  isReadOnly
                  width="100%"
                />
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
                        c.clearModel();
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
                    status={fieldStatus(errorMessage(validation.errors.modelKey))}
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
                        c.clearModel();
                        setAddMode('manual');
                      }}
                    />
                  </HStack>
                </VStack>
              ) : (
                // Manual fallback: paste the exact runtime lookup key.
                <VStack gap={1}>
                  <TextInput
                    value={draft.modelKey}
                    onChange={(value) => c.setField('modelKey', value)}
                    label={copy.modelKeyLabel}
                    placeholder={copy.modelKeyPlaceholder}
                    description={copy.keyHelp}
                    isRequired
                    hasAutoFocus
                    width="100%"
                    status={fieldStatus(errorMessage(validation.errors.modelKey))}
                  />
                  <HStack justify="end">
                    <Button
                      variant="ghost"
                      size="sm"
                      label={copy.catalogToggle}
                      onClick={() => {
                        // Clear the manually-typed key and its rates so catalog
                        // mode cannot save values hidden behind the picker.
                        c.clearModel();
                        setAddMode('catalog');
                      }}
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
              <PricingWriteNotice
                writeState={c.writeState}
                latestEntry={c.conflictLatestEntry}
                copy={copy}
                onRefresh={() => void c.reload()}
                refreshBusy={c.loading}
              />
              {c.needsReview ? (
                <Banner
                  status="warning"
                  role="status"
                  title={copy.hostChangedTitle}
                  description={copy.hostChangedBody}
                  endContent={
                    <Button
                      variant="secondary"
                      size="sm"
                      label={copy.reviewHostChange}
                      isDisabled={!c.hasAuthority}
                      onClick={c.reviewHostChange}
                    />
                  }
                />
              ) : null}
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
  onRefresh(): void;
  refreshBusy: boolean;
}) {
  const { writeState, latestEntry, copy } = props;
  switch (writeState.kind) {
    case 'conflict': {
      // An `outcome_unknown` conflict is uncertain, not a confirmed external
      // change — it must not be described as one.
      const uncertain = writeState.reason === 'outcome_unknown';
      const latest = latestEntry
        ? ` ${copy.conflictLatest(
            pricingSourceLabel(latestEntry, copy),
            formatUsd(latestEntry.inputUsdPer1M),
            formatUsd(latestEntry.outputUsdPer1M),
            formatCache(latestEntry.cacheReadUsdPer1M, copy),
            formatCache(latestEntry.cacheWriteUsdPer1M, copy),
          )}`
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
      return (
        <Banner
          status="warning"
          role="status"
          title={copy.refreshFailedTitle}
          description={copy.refreshFailedBody}
          endContent={<Button variant="secondary" size="sm" label={copy.refresh} isLoading={props.refreshBusy} onClick={props.onRefresh} />}
        />
      );
    case 'reconcile_unavailable':
      return (
        <Banner
          status="warning"
          role="status"
          title={copy.reconcileTitle}
          description={copy.reconcileBody}
          endContent={<Button variant="secondary" size="sm" label={copy.refresh} isLoading={props.refreshBusy} onClick={props.onRefresh} />}
        />
      );
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
