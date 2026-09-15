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

import { useEffect } from 'react';
import { useUiLocale, type TransientUserMessageProjection } from '@maka/ui';
import { getSessionLocalCopy } from '../../../locales/session-local-copy.js';
import { useConversationServices } from '../services.js';

export function SessionLocalMessages(props: {
  readonly sessionId?: string;
  readonly publish: (sessionId: string, message: TransientUserMessageProjection) => void;
  readonly retire: (sessionId: string, messageId: string) => void;
  readonly reportError: (message: string) => void;
}): null {
  const services = useConversationServices();
  const locale = useUiLocale();
  const { sessionId, publish, retire, reportError } = props;
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let revision = 0;
    const copy = getSessionLocalCopy(locale);
    const refresh = () => {
      const admitted = ++revision;
      void services
        .listMessages(sessionId)
        .then((messages) => {
          if (disposed || revision !== admitted) return;
          for (const message of messages) {
            if (message.state === 'accepted' && !message.turnId) {
              // The Host queue owns accepted steering and follow-ups. A local
              // durable copy is not a second pending row after withdrawal.
              retire(sessionId, message.messageId);
              continue;
            }
            const action = (operation: () => Promise<void>) => () => {
              void operation().catch(() => reportError(copy.updateError));
            };
            publish(sessionId, {
              id: message.messageId,
              text: message.text,
              ts: message.createdAt,
              transientPlacement: message.turnId ? 'current_turn' : message.placement,
              attachments: message.attachments,
              directoryReferences: message.directoryReferences,
              quotes: message.quotes,
              inlineReferences: message.inlineReferences,
              hostTurnId: message.turnId,
              deliveryStatus: copy[message.state],
              deliveryDetail: message.error,
              deliveryActions: message.canCancel
                ? [
                    {
                      label: copy.remove,
                      onClick: action(async () => {
                        await services.cancelMessage(sessionId, message.messageId);
                        retire(sessionId, message.messageId);
                      }),
                    },
                  ]
                : message.state === 'unknown'
                  ? [
                      {
                        label: copy.check,
                        onClick: action(() =>
                          services.reconcileMessage(sessionId, message.messageId),
                        ),
                      },
                    ]
                  : [],
            });
          }
        })
        .catch(() => undefined);
    };
    const unsubscribe = services.subscribeChanges((changedSessionId) => {
      if (changedSessionId === sessionId) refresh();
    });
    refresh();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [sessionId, services, publish, retire, reportError, locale]);
  return null;
}
