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

// The renderer type-scale base, in px. `makaTheme.ts` (THE type-scale
// authority — see the long comment there) feeds this into Astryx's
// `expandTypeScale`, and `theme.ts` divides by it to turn a chosen UI font
// size into a document-root font-size. It lives in this dependency-free
// module rather than in `makaTheme.ts` so the pre-paint bootstrap path
// (`cached-theme-bootstrap.ts` → `theme.ts`) does not pull the full theme
// (icon registry included) into the first frame.
//
// `DEFAULT_UI_FONT_SIZE` in `@maka/core/settings` must equal this value —
// the default means "the type scale as designed, no root scaling". Core
// cannot import renderer code, so the coupling is enforced by
// `font-size-type-scale.test.ts` instead of the type system.
export const TYPE_SCALE_BASE_PX = 14;
