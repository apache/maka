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

/**
 * Badge tones. Still its own vocabulary because Astryx's Badge has an `info`
 * pill and its own idea of `neutral`, so a Badge can express a shade the dot
 * cannot — mapping it through the status vocabulary would flatten that.
 *
 * Only 一处 still renders these (the subagent settings page). Everything else
 * on the settings surface is a dot plus plain text, per the "no decorative
 * Badge" principle.
 */
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';

export function statusBadgeVariant(tone: StatusTone): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
  switch (tone) {
    case 'success': return 'success';
    case 'warning': return 'warning';
    // Astryx Badge names the destructive status 'error' and the plain pill
    // 'neutral'.
    case 'destructive': return 'error';
    case 'info': return 'info';
    case 'neutral': return 'neutral';
  }
}
