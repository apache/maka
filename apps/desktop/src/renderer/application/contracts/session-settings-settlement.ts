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

import { createContext, useContext } from 'react';

/**
 * Lets a submission wait for the selected Session's in-flight setting writes
 * (Plan, model, permission, orchestration) without depending on the Session
 * Settings feature. The Composer shows a change as soon as it is requested,
 * while the Host admits a turn under the committed value (#4695).
 */
export interface SessionSettingsSettlement {
  /** True when every pending write committed (or none was pending). */
  settled(sessionId: string): Promise<boolean>;
  /**
   * Starts observing one submission attempt at the user's submit, so writes
   * that fail while it prepares (reference loading, revision copy) still
   * stop it. The caller must `release()` it when the attempt ends.
   */
  beginSettlement(sessionId: string): SessionSendSettlement;
}

/** One submission attempt's view of its Session's setting writes. */
export interface SessionSendSettlement {
  settled(): Promise<boolean>;
  release(): void;
}

const SessionSettingsSettlementContext = createContext<SessionSettingsSettlement | undefined>(undefined);

export const SessionSettingsSettlementProvider = SessionSettingsSettlementContext.Provider;

/** Undefined outside a Session Settings owner, where no write can be pending. */
export function useSessionSettingsSettlement(): SessionSettingsSettlement | undefined {
  return useContext(SessionSettingsSettlementContext);
}
