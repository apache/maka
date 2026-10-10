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

import { createContext, useContext, type ReactNode } from 'react';
import type { SettingsSection } from '@maka/core/settings';

export interface SettingsNavigation {
  openSettingsSection(section: SettingsSection): void;
}

export const SettingsNavigationContext = createContext<SettingsNavigation | null>(null);

export function useSettingsNavigation(): SettingsNavigation {
  const navigation = useContext(SettingsNavigationContext);
  if (!navigation) throw new Error('SettingsNavigationProvider is missing');
  return navigation;
}

export function SettingsNavigationProvider(props: {
  navigation: SettingsNavigation;
  children: ReactNode;
}) {
  return <SettingsNavigationContext.Provider value={props.navigation}>{props.children}</SettingsNavigationContext.Provider>;
}
