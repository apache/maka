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

/** Controller-owned facts from Electron events; this never initiates or waits for a load. */
export interface BrowserDocumentLoadSnapshot {
  readonly navigationId: number;
  readonly state: 'unknown' | 'loading' | 'completed' | 'failed' | 'stopped';
  readonly errorCode?: number;
}

export class BrowserDocumentLoad {
  private current: BrowserDocumentLoadSnapshot = { navigationId: 0, state: 'unknown' };
  private url = '';
  private committed = false;

  start(url: string): void {
    this.current = { navigationId: this.current.navigationId + 1, state: 'loading' };
    this.url = url;
    this.committed = false;
  }

  redirect(url: string): void {
    if (this.current.state === 'loading' && !this.committed) this.url = url;
  }

  commit(url: string): void {
    if (this.current.state === 'loading' && url === this.url) this.committed = true;
  }

  inPage(url: string): void {
    // A hash/history update changes the URL, not the document's load outcome.
    if (this.committed) this.url = url;
  }

  finish(url: string): void {
    if (this.current.state === 'loading' && this.committed && url === this.url) {
      this.current = { navigationId: this.current.navigationId, state: 'completed' };
    }
  }

  fail(url: string, errorCode: number): void {
    if (this.current.state !== 'loading' || url !== this.url) return;
    this.current = {
      navigationId: this.current.navigationId,
      state: errorCode === -3 ? 'stopped' : 'failed',
      errorCode,
    };
  }

  stop(): void {
    if (this.current.state === 'loading') {
      this.current = { navigationId: this.current.navigationId, state: 'stopped', errorCode: -3 };
    }
  }

  snapshot(): BrowserDocumentLoadSnapshot {
    return this.current;
  }
}
