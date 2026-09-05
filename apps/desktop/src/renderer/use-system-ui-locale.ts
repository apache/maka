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

import { resolveSystemUiLocale, type UiLocale } from '@maka/core/ui-locale';
import { useEffect, useState } from 'react';

export function readSystemUiLocale(): UiLocale {
  if (typeof navigator === 'undefined') return 'en';
  return resolveSystemUiLocale(navigator.languages);
}

/** Keep Follow system reactive when the operating-system language changes. */
export function useSystemUiLocale(): UiLocale {
  const [locale, setLocale] = useState(readSystemUiLocale);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleLanguageChange = () => setLocale(readSystemUiLocale());
    window.addEventListener('languagechange', handleLanguageChange);
    return () => window.removeEventListener('languagechange', handleLanguageChange);
  }, []);

  return locale;
}
