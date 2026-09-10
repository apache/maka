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

import { useEffect, useState, type ReactNode } from 'react';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import { useWorkHubServices } from '../services.js';
import { WorkHubRoot } from './workhub-root.js';

export function WorkHubSurfaceSwitch({ main }: { main: ReactNode }) {
  const services = useWorkHubServices();
  return services.surface === 'workhub' ? <WorkHubApplication /> : main;
}
function WorkHubApplication() {
  const services = useWorkHubServices();
  const [locale, setLocale] = useState(services.initialLocale);
  useEffect(() => services.subscribeAppearance(setLocale), [services]);
  useEffect(() => { void services.presentation.ready(); }, [services]);
  return <LocaleProvider locale={locale}><AstryxLocaleProvider><ToastProvider><WorkHubRoot /></ToastProvider></AstryxLocaleProvider></LocaleProvider>;
}
