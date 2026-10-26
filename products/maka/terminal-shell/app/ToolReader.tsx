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

import { textTooltip } from './ui';
import { tr } from './locale';
import { cleanup, computed, inputAction, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { Clipboard } from 'nsh';
import type { ToolSource } from './ToolSource';
import type { ToolChange, ToolProcess, ToolProjection, ToolRead, ToolSection } from './toolCards';
import { C, bodyTextStyle, captionTextStyle, codeTextStyle, controlStyle } from './ui';
import { Icon } from './Icon';

function Copy(props: { text(): string; label: string; source: ToolSource }) {
  const feedback = signal<{ text: string; error: string } | null>(null);
  let alive = true;
  let pending = false;
  cleanup(() => {
    alive = false;
  });
  const action = computed(() => {
    const originalText = props.text();
    const owns = () =>
      alive && props.source.complete() && !props.source.error() && props.text() === originalText;
    return inputAction(async () => {
      if (!owns() || pending) return;
      pending = true;
      try {
        await Clipboard.writeText(originalText);
        if (owns()) feedback.set({ text: originalText, error: '' });
      } catch (reason) {
        if (owns())
          feedback.set({
            text: originalText,
            error: reason instanceof Error ? reason.message : String(reason),
          });
      } finally {
        pending = false;
      }
    }, null);
  });
  const current = () => (feedback()?.text === props.text() ? feedback() : null);
  const copied = () => current() !== null && !current()!.error;
  return (
    <View style={{ alignItems: 'flex-end', minWidth: 32, flexShrink: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text selectable={false} style={{ ...captionTextStyle, color: C.muted }}>
          {copied() ? tr('Copied') : ''}
        </Text>
        <Button
          accessibilityLabel={props.label}
          tooltip={textTooltip(() => copied() ? tr('Copied') : props.label)}
          onPress={action()}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={{ backgroundColor: C.line }}
          focusStyle={{ backgroundColor: C.raised }}
        >
          <Icon name={copied() ? 'check' : 'copy'} color={C.secondary} />
        </Button>
      </View>
      <If when={current()?.error}>
        <Text selectable style={{ ...captionTextStyle, color: C.danger }}>
          {current()!.error}
        </Text>
      </If>
    </View>
  );
}

function ToolText(props: {
  label: string;
  text: string;
  copyLabel: string;
  source: ToolSource;
  userScroll(): void;
  gutter?: string;
  tone?: 'added' | 'removed' | 'warning';
}) {
  const color =
    props.tone === 'removed'
      ? C.danger
      : props.tone === 'added'
        ? '#78d7a1'
        : props.tone === 'warning'
          ? C.warning
          : C.text;
  return (
    <View style={{ minWidth: 0, borderRadius: 8, backgroundColor: C.background }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 4,
        }}
      >
        <Text
          selectable={false}
          style={{ ...captionTextStyle, color: C.secondary, flex: 1, minWidth: 0 }}
        >
          {props.label}
        </Text>
        <Copy label={props.copyLabel} text={() => props.text} source={props.source} />
      </View>
      <Scroll
        horizontal
        onScrollIntent={props.userScroll}
        contentStyle={{ paddingHorizontal: 12, paddingBottom: 12 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <If when={props.gutter !== undefined}>
            <Text
              pointerEvents="none"
              accessibilityElementsHidden
              selectable={false}
              style={{ ...codeTextStyle, color: C.muted, textAlign: 'right' }}
            >
              {props.gutter}
            </Text>
            <View
              pointerEvents="none"
              style={{ width: 1, alignSelf: 'stretch', backgroundColor: C.line }}
            />
          </If>
          <Text selectable style={{ ...codeTextStyle, color }}>
            {props.text}
          </Text>
        </View>
      </Scroll>
      <If when={props.text === ''}>
        <Text
          selectable={false}
          style={{ ...captionTextStyle, color: C.muted, paddingHorizontal: 12, paddingBottom: 12 }}
        >
          {tr('Empty recorded text.')}
        </Text>
      </If>
    </View>
  );
}

function Read(props: { value: ToolRead; source: ToolSource; userScroll(): void }) {
  const value = props.value;
  const lines = value.content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const gutter = lines.map((_, index) => String(value.offset + index + 1)).join('\n');
  const label = () =>
    value.partialLine
      ? tr('Read lines · partial line · {total} total', { total: value.totalLines })
      : tr('Read lines {first}–{last} / {total}', {
          first: value.returnedLines ? value.offset + 1 : value.offset,
          last: value.offset + value.returnedLines,
          total: value.totalLines,
        });
  return (
    <View style={{ gap: 8 }}>
      <ToolText
        label={label()}
        text={value.content}
        gutter={gutter}
        copyLabel={tr('Copy read contents')}
        source={props.source}
        userScroll={props.userScroll}
      />
      <If when={value.partialLine}>
        <Text selectable={false} style={{ ...captionTextStyle, color: C.warning }}>
          {tr('This original result contains part of a line.')}
        </Text>
      </If>
      <If when={value.hasMore}>
        <Text selectable={false} style={{ ...captionTextStyle, color: C.muted }}>
          {tr('The tool read a range of this file; this card preserves that original range.')}
        </Text>
      </If>
    </View>
  );
}

function Process(props: { value: ToolProcess; source: ToolSource; userScroll(): void }) {
  const value = props.value;
  const label = () =>
    ({
      starting: tr('Preparing at capture'),
      running: tr('Running at capture'),
      completed: tr('Completed'),
      failed: tr('Failed'),
      timed_out: tr('Timed out'),
      cancelled: tr('Stopped'),
      orphaned: tr('Outcome unknown'),
    })[value.status];
  const failed =
    value.status !== 'cancelled' &&
    (['failed', 'timed_out', 'orphaned'].includes(value.status) ||
      (value.exitCode !== null && value.exitCode !== 0));
  const output = value.output;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="terminal" color={failed ? C.danger : C.secondary} />
        <Text
          selectable={false}
          style={{
            ...captionTextStyle,
            color: failed ? C.danger : value.status === 'cancelled' ? C.warning : C.secondary,
          }}
        >
          {label()}
          {value.exitCode === null
            ? ''
            : ` · ${tr('Exit {code}', { code: String(value.exitCode) })}`}
        </Text>
      </View>
      <ToolText
        label={tr('Recorded command')}
        text={value.command}
        copyLabel={tr('Copy recorded command')}
        source={props.source}
        userScroll={props.userScroll}
      />
      <Text selectable style={{ ...captionTextStyle, color: C.muted }}>
        {tr('Working directory')} · {value.cwd}
      </Text>
      <If when={value.failure !== null}>
        <Text selectable style={{ ...bodyTextStyle, color: C.danger }}>
          {value.failure}
        </Text>
      </If>
      <If when={output === null}>
        <Text selectable={false} style={{ ...captionTextStyle, color: C.muted }}>
          {tr('No output was included in this original result.')}
        </Text>
      </If>
      {output?.mode === 'pipes' ? (
        <View style={{ gap: 8 }}>
          <ToolText
            label="stdout"
            text={output.stdout}
            copyLabel={tr('Copy stdout')}
            source={props.source}
            userScroll={props.userScroll}
          />
          <ToolText
            label="stderr"
            text={output.stderr}
            copyLabel={tr('Copy stderr')}
            source={props.source}
            userScroll={props.userScroll}
            tone="warning"
          />
          <If when={output.stdoutTruncated || output.stderrTruncated}>
            <Text selectable={false} style={{ ...captionTextStyle, color: C.warning }}>
              {tr('The recorded process output is truncated.')}
            </Text>
          </If>
        </View>
      ) : output?.mode === 'pty' ? (
        <View style={{ gap: 8 }}>
          <ToolText
            label={tr('Terminal scrollback')}
            text={output.scrollback}
            copyLabel={tr('Copy terminal scrollback')}
            source={props.source}
            userScroll={props.userScroll}
          />
          <ToolText
            label={tr('Terminal screen')}
            text={output.screen}
            copyLabel={tr('Copy terminal screen')}
            source={props.source}
            userScroll={props.userScroll}
          />
          <If when={output.lastAlternateScreen !== null}>
            <ToolText
              label={tr('Last alternate screen')}
              text={output.lastAlternateScreen!}
              copyLabel={tr('Copy last alternate screen')}
              source={props.source}
              userScroll={props.userScroll}
            />
          </If>
          <If when={output.truncated}>
            <Text selectable={false} style={{ ...captionTextStyle, color: C.warning }}>
              {tr('The recorded terminal output is truncated.')}
            </Text>
          </If>
        </View>
      ) : null}
      <If when={output?.redacted}>
        <Text selectable={false} style={{ ...captionTextStyle, color: C.warning }}>
          {tr('The Host redacted parts of this recorded output.')}
        </Text>
      </If>
    </View>
  );
}

function Change(props: { value: ToolChange; source: ToolSource; userScroll(): void }) {
  const value = props.value;
  if (value.phase === 'requested')
    return (
      <View style={{ gap: 8 }}>
        <Text selectable={false} style={{ ...captionTextStyle, color: C.muted }}>
          {tr('File')}
        </Text>
        <Text selectable style={{ ...bodyTextStyle, color: C.secondary }}>
          {value.path}
        </Text>
        {value.operation === 'write' ? (
          <ToolText
            label={tr('Requested file contents')}
            text={value.content}
            copyLabel={tr('Copy requested file contents')}
            tone="added"
            source={props.source}
            userScroll={props.userScroll}
          />
        ) : value.operation === 'edit' ? (
          <View style={{ gap: 8 }}>
            <ToolText
              label={tr('Requested removal')}
              text={value.before}
              copyLabel={tr('Copy requested removal')}
              tone="removed"
              source={props.source}
              userScroll={props.userScroll}
            />
            <ToolText
              label={tr('Requested replacement')}
              text={value.after}
              copyLabel={tr('Copy requested replacement')}
              tone="added"
              source={props.source}
              userScroll={props.userScroll}
            />
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <Text selectable={false} style={{ ...captionTextStyle, color: C.muted }}>
              {tr('Requested operation')} · {value.type}
            </Text>
            <If when={value.diff !== null}>
              <ToolText
                label={tr('Requested patch')}
                text={value.diff!}
                copyLabel={tr('Copy requested patch')}
                source={props.source}
                userScroll={props.userScroll}
              />
            </If>
          </View>
        )}
      </View>
    );
  if (value.operation === 'patch')
    return (
      <Text selectable={false} style={{ ...captionTextStyle, color: C.secondary }}>
        {tr(
          'Recorded patch result · Operation completed. The patch below is the original request.',
        )}
      </Text>
    );
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="check" color={C.accent} />
        <Text selectable={false} style={{ ...captionTextStyle, color: C.secondary }}>
          {value.operation === 'write' ? tr('Recorded write') : tr('Recorded edit')}
        </Text>
      </View>
      <Text selectable style={{ ...bodyTextStyle, color: C.secondary }}>
        {value.path}
      </Text>
      {value.operation === 'write' ? (
        <View style={{ gap: 8 }}>
          <Text selectable={false} style={{ ...captionTextStyle, color: C.muted }}>
            {tr('{count} bytes', { count: value.bytes })}
          </Text>
          <If
            when={value.previous !== null}
            else={
              <Text selectable={false} style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Previous contents were not included in this original result.')}
              </Text>
            }
          >
            <ToolText
              label={tr('Recorded previous contents')}
              text={value.previous!}
              copyLabel={tr('Copy recorded previous contents')}
              source={props.source}
              userScroll={props.userScroll}
              tone="removed"
            />
          </If>
        </View>
      ) : (
        <View style={{ gap: 4 }}>
          <Text selectable={false} style={{ ...captionTextStyle, color: C.muted }}>
            {tr('{count} replacements', { count: value.replacements })}
          </Text>
          <If when={value.startLine !== null && value.endLine !== null}>
            <Text selectable={false} style={{ ...captionTextStyle, color: C.muted }}>
              {tr('Recorded lines {first}–{last}', {
                first: value.startLine!,
                last: value.endLine!,
              })}
            </Text>
          </If>
          <If when={value.matchedVia !== null}>
            <Text selectable={false} style={{ ...captionTextStyle, color: C.muted }}>
              {tr('Match method')} · {value.matchedVia}
            </Text>
          </If>
        </View>
      )}
    </View>
  );
}

function Sections(props: { items: ToolSection[] }) {
  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      <Each of={props.items} key="index">
        {(section) => (
          <View
            style={{
              gap: 0,
              paddingHorizontal: 8,
              paddingVertical: 8,
              backgroundColor: C.background,
              borderRadius: 8,
            }}
          >
            <Text selectable={false} style={{ color: C.secondary, fontWeight: '600' }}>
              {section().label}
            </Text>
            <Text
              selectable
              style={{
                ...codeTextStyle,
                color:
                  section().tone === 'error' || section().tone === 'removed'
                    ? C.danger
                    : section().tone === 'warning'
                      ? C.warning
                      : section().tone === 'added'
                        ? '#78d7a1'
                        : C.text,
              }}
            >
              {section().text || tr('(empty)')}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}

export function ToolReader(props: {
  value: ToolProjection;
  source: ToolSource;
  userScroll(): void;
}) {
  const value = props.value;
  switch (value.kind) {
    case 'read':
      return <Read value={value.value} source={props.source} userScroll={props.userScroll} />;
    case 'process':
      return <Process value={value.value} source={props.source} userScroll={props.userScroll} />;
    case 'change':
      return <Change value={value.value} source={props.source} userScroll={props.userScroll} />;
    case 'sections':
      return (
        <Sections items={(props.value as Extract<ToolProjection, { kind: 'sections' }>).sections} />
      );
    case 'failure':
      return (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <Icon name="close" color={C.danger} />
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text selectable={false} style={{ ...captionTextStyle, color: C.danger }}>
              {tr('Tool failed')}
            </Text>
            <Text selectable style={{ ...bodyTextStyle, color: C.danger }}>
              {(props.value as Extract<ToolProjection, { kind: 'failure' }>).message}
            </Text>
          </View>
        </View>
      );
  }
}
