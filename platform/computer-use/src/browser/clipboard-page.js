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

function installVirtualClipboard(bindingName) {
  const key = '__makaVirtualClipboard';
  const previous = globalThis[key];
  if (previous?.bindingName === bindingName) return;
  previous?.cleanup();
  const binding = globalThis[bindingName];
  if (typeof binding !== 'function') throw new Error('Clipboard bridge is unavailable');

  const original = navigator.clipboard;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const pending = new Map();
  let sequence = 0;
  let clipboard;
  let patched;
  let replaced = new Map();

  const toBlob = (entry) => {
    let value = entry.text;
    if (typeof value !== 'string') {
      const decoded = atob(entry.base64 ?? '');
      const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
      value = bytes.buffer;
    }
    return new Blob([value], { type: entry.mimeType });
  };
  const toItem = (item) => {
    const presentationStyle = item.presentationStyle ?? 'unspecified';
    if (typeof ClipboardItem === 'function') {
      const values = Object.fromEntries(
        item.entries.map((entry) => [entry.mimeType, toBlob(entry)]),
      );
      return new ClipboardItem(values, { presentationStyle });
    }
    return {
      types: item.entries.map((entry) => entry.mimeType),
      presentationStyle,
      async getType(type) {
        const entry = item.entries.find((entry) => entry.mimeType === type);
        if (!entry) throw new DOMException(`No clipboard entry for ${type}`, 'NotFoundError');
        return toBlob(entry);
      },
    };
  };
  const encode = (buffer) => {
    const bytes = new Uint8Array(buffer);
    const parts = [];
    // Batch the function arguments; clipboard payloads are not truncated.
    for (let offset = 0; offset < bytes.length; offset += 8192)
      parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
    return btoa(parts.join(''));
  };
  const fromItems = (items) =>
    Promise.all(
      Array.from(items).map(async (item) => ({
        entries: await Promise.all(
          item.types.map(async (type) => {
            const blob = await item.getType(type);
            return type.startsWith('text/')
              ? { mimeType: type, text: await blob.text() }
              : { mimeType: type, base64: encode(await blob.arrayBuffer()) };
          }),
        ),
        presentationStyle: item.presentationStyle ?? 'unspecified',
      })),
    );
  const request = (operation, items) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      try {
        binding(JSON.stringify({ id, operation, items }));
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  const receiver = (value) => {
    if (value !== clipboard) throw new TypeError('Illegal invocation');
  };
  const methods = {
    async read() {
      receiver(this);
      return (await request('read')).map(toItem);
    },
    async readText() {
      receiver(this);
      const items = await request('read');
      const entry = items
        .flatMap((item) => item.entries)
        .find((entry) => entry.mimeType === 'text/plain');
      return entry ? toBlob(entry).text() : '';
    },
    async write(items) {
      receiver(this);
      if (arguments.length === 0) throw new TypeError('Clipboard.write requires an argument');
      const values = await fromItems(items);
      if (values.length) await request('write', values);
    },
    async writeText(text) {
      receiver(this);
      if (arguments.length === 0) throw new TypeError('Clipboard.writeText requires an argument');
      await request('write', [
        {
          entries: [{ mimeType: 'text/plain', text: `${text}` }],
          presentationStyle: 'unspecified',
        },
      ]);
    },
  };
  clipboard = {
    ...methods,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  };
  const getter = () => clipboard;
  const restore = () => {
    if (!patched) return;
    for (const [name, descriptor] of replaced) {
      if (Object.getOwnPropertyDescriptor(patched, name)?.value !== methods[name]) continue;
      if (descriptor) Object.defineProperty(patched, name, descriptor);
      else Reflect.deleteProperty(patched, name);
    }
    patched = undefined;
    replaced = new Map();
  };
  const patch = (object) => {
    patched = object;
    try {
      for (const [name, method] of Object.entries(methods)) {
        replaced.set(name, Object.getOwnPropertyDescriptor(object, name));
        Object.defineProperty(object, name, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: method,
        });
      }
      return true;
    } catch {
      restore();
      return false;
    }
  };
  if (original != null) {
    const prototype = Object.getPrototypeOf(original);
    if (
      patch(original) ||
      (prototype && Object.keys(methods).every((name) => name in prototype) && patch(prototype))
    )
      clipboard = original;
    else
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get: getter,
      });
  } else
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get: getter,
    });

  const controller = {
    bindingName,
    respond(serialized) {
      let reply;
      try {
        reply = JSON.parse(serialized);
      } catch {
        return;
      }
      const promise = pending.get(reply.id);
      if (!promise) return;
      pending.delete(reply.id);
      if (reply.ok) promise.resolve(Array.isArray(reply.items) ? reply.items : []);
      else promise.reject(new Error(reply.error ?? 'Clipboard request failed'));
    },
    cleanup() {
      if (globalThis[key] !== controller) return;
      for (const frame of document.querySelectorAll('iframe,frame'))
        if (frame instanceof HTMLIFrameElement || frame instanceof HTMLFrameElement)
          frame.contentWindow?.postMessage(bindingName, '*');
      globalThis.removeEventListener('message', onMessage);
      for (const promise of pending.values())
        promise.reject(new Error('Clipboard bridge was removed'));
      pending.clear();
      if (patched) restore();
      else if (Object.getOwnPropertyDescriptor(navigator, 'clipboard')?.get === getter) {
        if (navigatorDescriptor) Object.defineProperty(navigator, 'clipboard', navigatorDescriptor);
        else Reflect.deleteProperty(navigator, 'clipboard');
      }
      Reflect.deleteProperty(globalThis, key);
      if (globalThis[bindingName] === binding) Reflect.deleteProperty(globalThis, bindingName);
    },
  };
  const onMessage = (event) => {
    if (
      event.data === bindingName &&
      (event.source === globalThis || event.source === globalThis.parent)
    )
      controller.cleanup();
  };
  globalThis[key] = controller;
  globalThis.addEventListener('message', onMessage);
}
