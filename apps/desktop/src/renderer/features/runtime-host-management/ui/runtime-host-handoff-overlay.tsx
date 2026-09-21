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

import { useEffect, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Button, Text, useToast, useUiLocale } from '@maka/ui';
import type { RuntimeHostHandoffPayload } from '../ports.js';
import { getRuntimeHostHandoffCopy } from '../locales/runtime-host-handoff-copy.js';
import { useRuntimeHostManagementServices } from '../services-context.js';

/**
 * The in-window face of a Runtime Host handoff. Background reconciliation is
 * silent — only `attention` views (a decision the Host cannot make alone)
 * render here.
 */
export function RuntimeHostHandoffOverlay() {
  const locale = useUiLocale();
  const copy = getRuntimeHostHandoffCopy(locale);
  const toast = useToast();
  const handoff = useRuntimeHostManagementServices().handoff;
  const [payload, setPayload] = useState<RuntimeHostHandoffPayload | null>(null);
  useEffect(() => {
    let mounted = true;
    // Subscribe before fetching the snapshot: a push wins over the older
    // current() response whenever both are in flight.
    let pushed = false;
    const unsubscribe = handoff.subscribe((next) => {
      pushed = true;
      if (mounted) setPayload(next);
    });
    void handoff
      .current()
      .then((current) => {
        if (mounted && !pushed) setPayload(current);
      })
      .catch(() => {});
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [handoff]);

  const view = payload?.view;
  const presentation = payload?.presentation;
  if (view?.state !== 'attention' || !presentation) return null;
  const decide = (action: string) => {
    void handoff.decide(view.revision, action);
  };

  return (
    <>
      {/* Retires the launch overlay: the data it waits on may be blocked
          behind this very decision, so the dialog cannot wait for it. */}
      <span data-maka-content-ready hidden />
      <Dialog isOpen onOpenChange={() => {}} purpose="required" width={480}>
      <Layout
        header={(
          <DialogHeader
            title={presentation.title}
            subtitle={presentation.description}
          />
        )}
        content={(
          <LayoutContent padding={4}>
            {presentation.detail ? (
              <Text type="body" display="block">
                <span style={{ whiteSpace: 'pre-line' }}>{presentation.detail}</span>
              </Text>
            ) : null}
            <Button
              variant="ghost"
              label={copy.copyDiagnostics}
              onClick={() =>
                void handoff
                  .copyText(JSON.stringify(view, null, 2))
                  .then(() => toast.success(copy.diagnosticsCopied))
                  .catch(() => {})}
            />
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter>
            {presentation.actions.map(({ action, label }) => (
              <Button
                key={action}
                variant={
                  action === 'interrupt'
                    ? 'destructive'
                    : action === view.defaultAction
                      ? 'primary'
                      : 'secondary'
                }
                label={label}
                onClick={() => decide(action)}
              />
            ))}
          </LayoutFooter>
        )}
      />
    </Dialog>
    </>
  );
}
