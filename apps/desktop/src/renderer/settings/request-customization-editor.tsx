import { HStack, Text, VStack } from '@astryxdesign/core';
import {
  normalizeOptionalRequestBodyOverlay,
  normalizeRequestHeaderUpdates,
  normalizeRequestHeaders,
  type JsonObject,
} from '@maka/core/runtime-policy';
import { type RequestHeaderUpdate } from '@maka/core/llm-connections';
import { Button, IconButton, TextArea, TextInput } from '@maka/ui';
import { Trash2 } from '@maka/ui/icons';
import { PasswordInput } from './password-input';

export interface RequestHeaderDraft {
  readonly id: number;
  readonly name: string;
  readonly value: string;
  readonly retained: boolean;
}

export function savedRequestHeaderDrafts(names: readonly string[]): RequestHeaderDraft[] {
  return names.map((name, index) => ({ id: index + 1, name, value: '', retained: true }));
}

export function requestHeaderUpdates(
  drafts: readonly RequestHeaderDraft[],
): readonly RequestHeaderUpdate[] {
  return normalizeRequestHeaderUpdates(
    drafts.map(({ name, value, retained }) =>
      retained && value.length === 0 ? { name } : { name, value },
    ),
  );
}

export function newRequestHeaders(
  drafts: readonly RequestHeaderDraft[],
): Readonly<Record<string, string>> {
  const updates = normalizeRequestHeaderUpdates(
    drafts.map(({ name, value }) => ({ name, value })),
  );
  return normalizeRequestHeaders(
    Object.fromEntries(updates.map(({ name, value }) => [name, value ?? ''])),
  );
}

export function parseRequestBodyOverlay(text: string): JsonObject | undefined {
  if (!text.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Extra request body must be valid JSON');
  }
  return normalizeOptionalRequestBodyOverlay(value);
}

export function formatRequestBodyOverlay(value: JsonObject | undefined): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

export function RequestCustomizationEditor(props: {
  headers: readonly RequestHeaderDraft[];
  onHeadersChange(headers: RequestHeaderDraft[]): void;
  bodyText: string;
  onBodyTextChange(value: string): void;
  disabled?: boolean;
  copy: {
    headers: string;
    headerName: string;
    headerValue: string;
    retainedValue: string;
    addHeader: string;
    removeHeader: string;
    noHeaders: string;
    body: string;
    bodyHelp: string;
  };
}) {
  return (
    <VStack gap={4}>
      <RequestHeadersEditor {...props} />
      <RequestBodyEditor {...props} />
    </VStack>
  );
}

export function RequestHeadersEditor(props: {
  headers: readonly RequestHeaderDraft[];
  onHeadersChange(headers: RequestHeaderDraft[]): void;
  disabled?: boolean;
  hideTitle?: boolean;
  copy: {
    headers: string;
    headerName: string;
    headerValue: string;
    retainedValue: string;
    addHeader: string;
    removeHeader: string;
    noHeaders: string;
  };
}) {
  const nextId = props.headers.reduce((highest, header) => Math.max(highest, header.id), 0) + 1;
  function update(id: number, patch: Partial<RequestHeaderDraft>) {
    props.onHeadersChange(
      props.headers.map((header) =>
        header.id === id
          ? {
              ...header,
              ...patch,
              ...(patch.name !== undefined && patch.name !== header.name ? { retained: false } : {}),
            }
          : header,
      ),
    );
  }
  return (
    <VStack gap={2}>
      {!props.hideTitle && <Text weight="semibold">{props.copy.headers}</Text>}
      {props.headers.length === 0 && (
        <Text type="supporting" color="secondary">
          {props.copy.noHeaders}
        </Text>
      )}
      {props.headers.map((header) => (
        <div key={header.id} className="requestHeaderRow">
          <div className="requestHeaderName">
            <TextInput
              label={props.copy.headerName}
              isLabelHidden
              value={header.name}
              onChange={(name) => update(header.id, { name })}
              placeholder="HTTP-Referer"
              isDisabled={props.disabled}
              width="100%"
            />
          </div>
          <div className="requestHeaderValue">
            <PasswordInput
              label={props.copy.headerValue}
              isLabelHidden
              value={header.value}
              onChange={(value) => update(header.id, { value })}
              placeholder={header.retained ? props.copy.retainedValue : props.copy.headerValue}
              isDisabled={props.disabled}
            />
          </div>
          <div className="requestHeaderRemove">
            <IconButton
              variant="ghost"
              size="sm"
              label={props.copy.removeHeader}
              icon={<Trash2 size={16} aria-hidden="true" />}
              isDisabled={props.disabled}
              onClick={() =>
                props.onHeadersChange(props.headers.filter(({ id }) => id !== header.id))
              }
            />
          </div>
        </div>
      ))}
      <HStack>
        <Button
          variant="ghost"
          size="sm"
          label={props.copy.addHeader}
          isDisabled={props.disabled || props.headers.length >= 32}
          onClick={() =>
            props.onHeadersChange([
              ...props.headers,
              { id: nextId, name: '', value: '', retained: false },
            ])
          }
        />
      </HStack>
    </VStack>
  );
}

export function RequestBodyEditor(props: {
  bodyText: string;
  onBodyTextChange(value: string): void;
  disabled?: boolean;
  hideLabel?: boolean;
  copy: { body: string; bodyHelp: string };
}) {
  return (
    <TextArea
      label={props.copy.body}
      isLabelHidden={props.hideLabel}
      value={props.bodyText}
      onChange={props.onBodyTextChange}
      placeholder={'{\n  "provider": {\n    "order": ["Anthropic"]\n  }\n}'}
      description={props.copy.bodyHelp}
      isDisabled={props.disabled}
      rows={6}
      width="100%"
    />
  );
}
