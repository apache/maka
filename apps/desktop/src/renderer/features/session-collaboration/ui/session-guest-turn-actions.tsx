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

import { type ReactNode } from 'react';
import {
  type TurnFooterActionMeta,
  type TurnPresentation,
  type TurnPresentationDeriver,
} from '@maka/ui';

type TurnFooterActionHandler = (
  turnId: string,
  actionId: TurnFooterActionMeta['id'],
) => void | Promise<void>;

interface GuestTurnActions {
  readonly deriveTurnPresentation: TurnPresentationDeriver;
  readonly onTurnFooterAction: TurnFooterActionHandler;
}

export function SessionGuestTurnActionBoundary(props: {
  readonly sessionId: string | undefined;
  readonly deriveTurnPresentation: TurnPresentationDeriver;
  readonly ownerTurnFooterAction: TurnFooterActionHandler;
  readonly children: (actions: GuestTurnActions) => ReactNode;
}) {
  return props.children({
    deriveTurnPresentation: (turns) => {
      const presentation = props.deriveTurnPresentation(turns);
      return props.sessionId ? guestTurnPresentation(presentation) : presentation;
    },
    onTurnFooterAction: props.ownerTurnFooterAction,
  });
}

function guestTurnPresentation(source: TurnPresentation): TurnPresentation {
  return {
    ...source,
    footerActionsByTurn: Object.fromEntries(
      Object.entries(source.footerActionsByTurn).map(([turnId, actions]) => [
        turnId,
        actions.filter((action) => action.id !== 'branch'),
      ]),
    ),
  };
}
