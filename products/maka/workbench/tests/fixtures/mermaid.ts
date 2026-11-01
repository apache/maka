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

import { text } from 'nsh:rt';
import { diagramSvg } from '../../app/mermaid';

text(
  JSON.stringify(
    diagramSvg(
      'flowchart LR\n A[用户 User] --> B[Maka]',
      {
        background: '#ffffff',
        text: '#112233',
        muted: '#666666',
        secondary: '#445566',
        surface: '#eeeeee',
        raised: '#dddddd',
        line: '#999999',
        accent: '#3366ff',
        danger: '#cc0000',
      },
      720,
    ),
  ),
);
