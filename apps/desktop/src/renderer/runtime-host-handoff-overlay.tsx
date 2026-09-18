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
import { Button, Text, useUiLocale } from '@maka/ui';
import type { DesktopHostHandoffPayload } from '../preload/bridge-contract.js';
import { getRuntimeHostHandoffCopy } from './locales/runtime-host-handoff-copy.js';

/**
 * The in-window face of a Runtime Host handoff. Background reconciliation is
 * silent — only `attention` views (a decision the Host cannot make alone)
 * render here.
 */
export function RuntimeHostHandoffOverlay() {
  const locale = useUiLocale();
  const copy = getRuntimeHostHandoffCopy(locale);
  const [payload, setPayload] = useState<DesktopHostHandoffPayload | null>(null);
  useEffect(() => {
    const bridge = window.maka?.runtimeHostHandoff;
    if (!bridge) return;
    let mounted = true;
    void bridge.current().then((current) => {
      if (mounted) setPayload(current);
    });
    const unsubscribe = bridge.subscribe(setPayload);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const view = payload?.view;
  const presentation = payload?.presentation;
  if (view?.state !== 'attention' || !presentation) return null;
  const decide = (action: string) => {
    void window.maka.runtimeHostHandoff.decide(view.revision, action);
  };

  return (
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
                void navigator.clipboard.writeText(JSON.stringify(view, null, 2))}
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
  );
}
