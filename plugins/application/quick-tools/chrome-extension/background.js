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

// Browser state is pushed only when tabs change. No page scripts or remote requests.
let port;
let timer;
let revision = 0;
function send(value) {
  try {
    port?.postMessage(value);
  } catch {}
}
async function snapshot() {
  const version = ++revision;
  const tabs = await chrome.tabs.query({});
  if (version !== revision) return;
  send({
    type: 'tabs',
    tabs: tabs
      .filter((t) => !t.incognito)
      .slice(0, 2000)
      .map((t) => ({
        id: t.id,
        windowId: t.windowId,
        title: (t.title || 'Untitled').slice(0, 1000),
        url: (t.url || '').slice(0, 4000),
        pinned: !!t.pinned,
      })),
  });
}
function changed() {
  clearTimeout(timer);
  timer = setTimeout(() => snapshot().catch(() => {}), 80);
}
function connect() {
  if (port) return;
  const current = chrome.runtime.connectNative('org.maka.quick_tabs');
  port = current;
  current.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port === current) port = undefined;
    chrome.action.setBadgeText({ text: '!' });
    chrome.alarms.create('reconnect', { delayInMinutes: 0.5 });
  });
  current.onMessage.addListener(async (message) => {
    if (
      message.type !== 'command' ||
      typeof message.request !== 'string' ||
      !Number.isInteger(message.id)
    )
      return;
    try {
      const tab = await chrome.tabs.get(message.id);
      if (tab.incognito) throw Error('Private tabs are not supported');
      if (message.action === 'activate') {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      } else if (message.action === 'close') await chrome.tabs.remove(tab.id);
      else if (message.action === 'pin') await chrome.tabs.update(tab.id, { pinned: !tab.pinned });
      else throw Error('Unknown action');
      send({ type: 'result', request: message.request });
      changed();
    } catch (error) {
      send({ type: 'result', request: message.request, error: String(error.message || error) });
    }
  });
  chrome.action.setBadgeText({ text: '' });
  snapshot().catch(() => {});
}
for (const event of [
  chrome.tabs.onCreated,
  chrome.tabs.onUpdated,
  chrome.tabs.onRemoved,
  chrome.tabs.onAttached,
  chrome.tabs.onDetached,
  chrome.tabs.onMoved,
  chrome.tabs.onActivated,
])
  event.addListener(changed);
chrome.action.onClicked.addListener(() => {
  connect();
  changed();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect') connect();
});
connect();
