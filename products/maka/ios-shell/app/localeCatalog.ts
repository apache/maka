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

import { createI18n } from '../../../../packages/plugin-sdk/src/index.js';
import de from '../locales/de.json' with { type: 'json' };
import en from '../locales/en.json' with { type: 'json' };
import es from '../locales/es.json' with { type: 'json' };
import fr from '../locales/fr.json' with { type: 'json' };
import it from '../locales/it.json' with { type: 'json' };
import ja from '../locales/ja.json' with { type: 'json' };
import ko from '../locales/ko.json' with { type: 'json' };
import ptBR from '../locales/pt-BR.json' with { type: 'json' };
import ru from '../locales/ru.json' with { type: 'json' };
import zhCN from '../locales/zh-CN.json' with { type: 'json' };
import zhHK from '../locales/zh-HK.json' with { type: 'json' };
import zhTW from '../locales/zh-TW.json' with { type: 'json' };

export type MessageKey = keyof typeof en;

export const { t: translate } = createI18n<MessageKey>({
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'zh-HK': zhHK,
  ja,
  ko,
  es,
  fr,
  de,
  'pt-BR': ptBR,
  ru,
  it,
});
