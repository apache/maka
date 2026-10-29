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

// The enclosing bootstrap supplies call/emit; neither is exposed to model code.
const ErrorClass = Error;
const stringify = JSON.stringify;
const parse = JSON.parse;
const decodeTabMetadata = (row) => {
  const { titleJson, tabGroupJson, ...info } = row;
  if (Object.prototype.hasOwnProperty.call(row, 'titleJson')) info.title = parse(titleJson);
  if (Object.prototype.hasOwnProperty.call(row, 'tabGroupJson')) info.tabGroup = parse(tabGroupJson);
  return info;
};
const decodeBrowserState = (state) => ({
  ...state,
  browsers: state.browsers.map((browser) => ({
    ...browser,
    tabs: browser.tabs.map(decodeTabMetadata),
  })),
});
const output = (value) => {
  const error = emit(value);
  if (error) throw new ErrorClass(error.message);
};
const write = (value) =>
  output({
    kind: 'text',
    text: typeof value === 'string' ? value : (stringify(value) ?? 'undefined'),
  });
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const decode = (value) => {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const result = new Uint8Array(Math.floor((value.length * 3) / 4) - padding);
  let offset = 0;
  let bits = 0;
  let buffer = 0;
  for (const ch of value) {
    if (ch === '=') break;
    const n = alphabet.indexOf(ch);
    if (n < 0) throw new ErrorClass('Invalid base64 data');
    buffer = (buffer << 6) | n;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result[offset++] = (buffer >> bits) & 255;
    }
  }
  return result;
};
const encode = (bytes) => {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    result +=
      alphabet[(n >> 18) & 63] +
      alphabet[(n >> 12) & 63] +
      (i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : '=') +
      (i + 2 < bytes.length ? alphabet[n & 63] : '=');
  }
  return result;
};
const emitImage = async (value) => {
  let image;
  if (typeof value === 'string') {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(value);
    if (!match)
      throw new ErrorClass(
        'Expected an image data URL; filesystem and URL fetching are unavailable',
      );
    image = { type: 'image', mimeType: match[1], data: match[2] };
  } else if (value?.type === 'image') {
    image = { type: 'image', mimeType: value.mimeType, data: value.data };
  } else {
    const bytes = value instanceof Uint8Array ? value : value?.bytes;
    if (!(bytes instanceof Uint8Array))
      throw new ErrorClass('Expected image bytes or an image content block');
    const mimeType =
      value.mimeType ??
      (bytes[0] === 137 ? 'image/png' : bytes[0] === 255 ? 'image/jpeg' : 'image/webp');
    image = { type: 'image', mimeType, data: encode(bytes) };
  }
  output({ kind: 'media', content: image });
};
const audio = (value) => {
  if (typeof value === 'string') {
    const match = /^data:(audio\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/.exec(value);
    if (!match)
      throw new ErrorClass(
        'Expected an audio data URL; filesystem and URL fetching are unavailable',
      );
    return { type: 'audio', mimeType: match[1], data: match[2] };
  }
  if (value?.type === 'audio') return { type: 'audio', mimeType: value.mimeType, data: value.data };
  const bytes = value instanceof Uint8Array ? value : value?.bytes;
  if (!(bytes instanceof Uint8Array))
    throw new ErrorClass('Expected audio bytes or an audio content block');
  return {
    type: 'audio',
    mimeType: value.mimeType ?? 'audio/wav',
    data: encode(bytes),
  };
};
const emitAudio = async (value) => output({ kind: 'media', content: audio(value) });
const invoke = async (method, args = {}) => {
  const result = await call('cua', { method, ...args });
  if (!result.ok) throw new ErrorClass(result.error.message);
  return result.value;
};
class PlaywrightFileChooser {
  #handle;
  #id;
  #multiple;
  constructor(handle, id, multiple) {
    this.#handle = handle;
    this.#id = id;
    this.#multiple = multiple;
  }
  isMultiple() {
    return this.#multiple;
  }
  async setFiles(files, options = {}) {
    if (files == null) throw new ErrorClass('fileChooser.setFiles requires files');
    const paths = Array.isArray(files) ? files : [files];
    if (paths.length === 0) throw new ErrorClass('fileChooser.setFiles requires at least one file');
    await invoke('browserFileChooserSetFiles', {
      handle: this.#handle,
      fileChooserId: this.#id,
      files: paths,
      options: { timeoutMs: options?.timeoutMs },
    });
  }
}
class PlaywrightDownload {
  #handle;
  #scope;
  #id;
  constructor(handle, scope, id) {
    this.#handle = handle;
    this.#scope = scope;
    this.#id = id;
  }
  async path({ timeoutMs } = {}) {
    return (
      (
        await invoke('browserDownloadPath', {
          handle: this.#handle,
          scope: this.#scope,
          downloadId: this.#id,
          options: { timeoutMs },
        })
      ).path ?? null
    );
  }
}
const locatorBindings = new WeakMap();
const regexSelector = (value) => {
  const expression = String(value);
  if (value.unicode || value.unicodeSets) return expression;
  let result = '';
  let escaped = false;
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    if (!escaped && ['"', "'", '`'].includes(character)) result += '\\';
    if (!escaped && character === '>' && expression[index + 1] === '>') {
      result += '\\>\\>';
      index++;
      continue;
    }
    result += character;
    escaped = character === '\\' && !escaped;
  }
  return result;
};
const textSelector = (value, exact, attribute = false) => {
  if (value instanceof RegExp) return regexSelector(value);
  if (typeof value !== 'string') throw new ErrorClass('Expected a string or RegExp');
  const quoted = attribute
    ? '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
    : stringify(value);
  return quoted + (exact ? 's' : 'i');
};
const playwrightFor = (handle, identity) => {
  const combine = (base, query) => (base ? base + ' >> ' + query : query);
  const optionsFor = ({ timeoutMs } = {}) => ({ timeoutMs });
  const request = (selector, operation, options) =>
    invoke('browserRead', {
      handle,
      locator: { selector },
      operation,
      options: optionsFor(options),
    });
  const mutationOptions = (options, method) => {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new ErrorClass('locator.' + method + ' options must be an object');
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0))
      throw new ErrorClass('timeoutMs must be a positive integer');
    return { timeoutMs };
  };
  const pointerOptions = (options, method, checked = false) => {
    const result = mutationOptions(options, method);
    if (options.force !== undefined) {
      if (typeof options.force !== 'boolean') throw new ErrorClass('force must be a boolean');
      result.force = options.force;
    }
    if (checked) return result;
    if (options.button !== undefined) {
      if (!['left', 'right', 'middle'].includes(options.button))
        throw new ErrorClass('button must be left, right, or middle');
      result.button = options.button;
    }
    if (options.modifiers !== undefined) {
      if (
        !Array.isArray(options.modifiers) ||
        options.modifiers.some(
          (value) => !['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'].includes(value),
        )
      )
        throw new ErrorClass('Unsupported keyboard modifier');
      result.modifiers = options.modifiers;
    }
    return result;
  };
  const selectValues = (value) => {
    const values = Array.isArray(value) ? value : [value];
    if (!values.length) throw new ErrorClass('locator.selectOption requires at least one value');
    return values.map((value) => {
      if (typeof value === 'string') return { value };
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ErrorClass('locator.selectOption requires option values or descriptors');
      const result = {};
      for (const property of ['value', 'label']) {
        if (value[property] !== undefined) {
          if (typeof value[property] !== 'string')
            throw new ErrorClass(property + ' must be a string');
          result[property] = value[property];
        }
      }
      if (value.index !== undefined) {
        if (!Number.isInteger(value.index) || value.index < 0)
          throw new ErrorClass('index must be a non-negative integer');
        result.index = value.index;
      }
      if (!Object.keys(result).length)
        throw new ErrorClass('locator.selectOption requires a value, label, or index');
      return result;
    });
  };
  const compatible = (other) => {
    const binding = locatorBindings.get(other);
    if (!binding) throw new ErrorClass('Expected a PlaywrightLocator');
    if (binding.identity !== identity || binding.handle.id !== handle.id)
      throw new ErrorClass('Locators must belong to the same tab');
    return binding.selector;
  };
  const filters = (options) => {
    const result = [];
    for (const [property, query] of [
      ['hasText', 'has-text'],
      ['hasNotText', 'has-not-text'],
    ])
      if (options[property] !== undefined)
        result.push('internal:' + query + '=' + textSelector(options[property], false));
    for (const [property, query] of [
      ['has', 'has'],
      ['hasNot', 'has-not'],
    ])
      if (options[property] !== undefined)
        result.push('internal:' + query + '=' + stringify(compatible(options[property])));
    if (options.visible !== undefined) {
      if (typeof options.visible !== 'boolean')
        throw new ErrorClass('locator.filter visible must be a boolean');
      result.push('visible=' + options.visible);
    }
    return result.join(' >> ');
  };
  const queryBuilders = (select) => ({
    getByRole: (role, options = {}) => {
      if (!role) throw new ErrorClass('getByRole requires a role');
      const name =
        options.name === undefined
          ? ''
          : '[name=' + textSelector(options.name, !!options.exact, true) + ']';
      return select('internal:role=' + role + name);
    },
    getByText: (text, options = {}) =>
      select('internal:text=' + textSelector(text, !!options.exact)),
    getByLabel: (text, options = {}) =>
      select('internal:label=' + textSelector(text, !!options.exact)),
    getByPlaceholder: (text, options = {}) =>
      select('internal:attr=[placeholder=' + textSelector(text, !!options.exact, true) + ']'),
    getByTestId: (value) => {
      if (!value) throw new ErrorClass('getByTestId requires a testId');
      return select('internal:testid=[data-testid=' + textSelector(value, true, true) + ']');
    },
  });
  const checkedSelector = (selector) => {
    if (!selector || typeof selector !== 'string')
      throw new ErrorClass('locator requires a selector');
    return selector;
  };
  const evaluate = async (selector, mode, pageFunction, arg, options) => {
    const operation =
      mode === 'all'
        ? 'locator.evaluateAll'
        : mode === 'element'
          ? 'locator.evaluate'
          : 'playwright.evaluate';
    let literal;
    if (arg === undefined) literal = 'undefined';
    else {
      try {
        literal = stringify(arg);
      } catch (error) {
        throw new ErrorClass(
          'playwright.evaluate arg must be JSON-serializable\n' +
            (error instanceof ErrorClass ? error.message : String(error)),
        );
      }
      if (literal === undefined)
        throw new ErrorClass('playwright.evaluate arg must be JSON-serializable');
    }
    let script;
    if (typeof pageFunction === 'string') {
      if (pageFunction.length === 0) throw new ErrorClass(operation + ' requires a pageFunction');
      script = 'const arg = ' + literal + ';\nreturn (' + pageFunction + ');';
    } else if (typeof pageFunction === 'function') {
      const parameters =
        mode === 'all' ? 'elements, arg' : mode === 'element' ? 'element, arg' : 'arg';
      script =
        'const arg = ' +
        literal +
        ';\nconst __playwrightEvaluate = (' +
        pageFunction.toString() +
        ');\nreturn await __playwrightEvaluate(' +
        parameters +
        ');';
    } else throw new ErrorClass(operation + ' requires a string or function');
    if (/\bimport\b(?:(?:\s+)|(?:\/\/[^\n\r]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/))*\(/u.test(script))
      throw new ErrorClass('module loading is not available in playwright.evaluate');
    const packet = await invoke('browserEvaluate', {
      handle,
      locator: selector === undefined ? undefined : { selector },
      mode,
      scriptJson: stringify(script),
      options: { timeoutMs: options?.timeoutMs },
    });
    if (typeof packet.errorJson === 'string') throw new ErrorClass(parse(packet.errorJson));
    const result = parse(packet.json);
    for (const path of parse(packet.negativeZerosJson)) {
      let target = result;
      for (let index = 0; index < path.length; index++) {
        const key = path[index];
        if (
          !target ||
          typeof target !== 'object' ||
          !Object.prototype.hasOwnProperty.call(target, key)
        )
          break;
        if (index === path.length - 1) target[key] = -0;
        else target = target[key];
      }
    }
    return result.value;
  };

  const locatorFor = (selector, collection) => {
    const mutate = async (operation) => {
      await invoke('browserMutation', { handle, locator: { selector }, operation });
      collection?.cache.rows.clear();
    };
    const textMutation = (kind, value, options = {}) => {
      if (typeof value !== 'string')
        throw new ErrorClass('locator.' + kind + ' requires a string value');
      return mutate({ kind, value, options: mutationOptions(options, kind) });
    };
    const setChecked = (checked, options = {}) => {
      if (typeof checked !== 'boolean') throw new ErrorClass('checked must be a boolean');
      return mutate({
        kind: 'setChecked',
        checked,
        options: pointerOptions(options, 'setChecked', true),
      });
    };
    const cachedRow = async (options) => {
      if (!collection) return null;
      const key = collection.relative ?? '';
      let pending = collection.cache.rows.get(key);
      if (!pending) {
        pending = request(
          collection.cache.selector,
          { kind: 'rows', relative: key ? { selector: key } : undefined },
          options,
        ).catch((error) => {
          collection.cache.rows.delete(key);
          throw error;
        });
        collection.cache.rows.set(key, pending);
      }
      return (await pending)[collection.index] ?? null;
    };
    const derived = (query) =>
      locatorFor(
        combine(selector, query),
        collection
          ? {
              ...collection,
              relative: combine(collection.relative, query),
            }
          : undefined,
      );
    const locator = (query, options = {}) => derived(checkedSelector(query)).filter(options);
    const locatorTarget = {
      ...queryBuilders((query) => locator(query)),
      locator,
      first: () => derived('nth=0'),
      last: () => derived('nth=-1'),
      nth: (index) => {
        if (typeof index !== 'number') throw new ErrorClass('locator.nth requires a numeric index');
        return derived('nth=' + index);
      },
      and: (other) => locatorFor(combine(selector, 'internal:and=' + stringify(compatible(other)))),
      or: (other) => locatorFor(combine(selector, 'internal:or=' + stringify(compatible(other)))),
      filter: (options = {}) => {
        const query = filters(options);
        return locatorFor(
          query ? combine(selector, query) : selector,
          collection && (!query || collection.relative !== undefined)
            ? {
                ...collection,
                relative: query ? combine(collection.relative, query) : collection.relative,
              }
            : undefined,
        );
      },
      evaluate: (pageFunction, arg, options) =>
        evaluate(selector, 'element', pageFunction, arg, options),
      evaluateAll: (pageFunction, arg, options) =>
        evaluate(selector, 'all', pageFunction, arg, options),
      count: () => request(selector, { kind: 'count' }),
      all: async () => {
        const count = await request(selector, { kind: 'count' });
        const cache = { selector, rows: new Map() };
        return Array.from({ length: count }, (_, index) =>
          locatorFor(combine(selector, 'nth=' + index), { cache, index }),
        );
      },
      allTextContents: (options) => request(selector, { kind: 'allTextContents' }, options),
      textContent: async (options) => {
        const row = await cachedRow(options);
        return row ? row.textContent : request(selector, { kind: 'textContent' }, options);
      },
      innerText: async (options) => {
        const row = await cachedRow(options);
        return row ? row.innerText : request(selector, { kind: 'innerText' }, options);
      },
      getAttribute: async (name, options) => {
        if (!name || typeof name !== 'string')
          throw new ErrorClass('locator.getAttribute requires a name');
        const row = await cachedRow(options);
        return row
          ? Object.prototype.hasOwnProperty.call(row.attributes, name)
            ? (row.attributes[name] ?? null)
            : null
          : request(selector, { kind: 'getAttribute', name }, options);
      },
      isEnabled: () => request(selector, { kind: 'isEnabled' }),
      isVisible: () => request(selector, { kind: 'isVisible' }),
      click: (options = {}) => mutate({ kind: 'click', options: pointerOptions(options, 'click') }),
      dblclick: (options = {}) =>
        mutate({ kind: 'doubleClick', options: pointerOptions(options, 'dblclick') }),
      fill: (value, options) => textMutation('fill', value, options),
      type: (value, options) => textMutation('type', value, options),
      press: (value, options) => textMutation('press', value, options),
      pressSequentially: (value, options) => textMutation('pressSequentially', value, options),
      selectOption: (value, options = {}) =>
        mutate({
          kind: 'selectOption',
          values: selectValues(value),
          options: mutationOptions(options, 'selectOption'),
        }),
      setChecked,
      check: (options) => setChecked(true, options),
      uncheck: (options) => setChecked(false, options),
      waitFor: async ({ state, timeoutMs }) => {
        if (!state) throw new ErrorClass('locator.waitFor requires a state');
        try {
          await invoke('browserWait', {
            handle,
            operation: { kind: 'locator', locator: { selector }, state, timeoutMs },
          });
        } catch (error) {
          const message = error instanceof ErrorClass ? error.message : String(error);
          let details = 'locator.waitFor(' + state + ') timed out for selector ' + selector;
          try {
            const report = await request(
              selector,
              { kind: 'waitDiagnostics' },
              { timeoutMs: 1000 },
            );
            let kind = 'action_failed';
            if (/strict mode violation/i.test(message)) kind = 'multiple_matches';
            else if (/intercept|receives pointer events/i.test(message)) kind = 'intercepted';
            else if (report.matchCount === 0) kind = 'no_matches';
            else if (report.visibleCount === 0) kind = 'no_visible_match';
            details +=
              '\nLocator diagnostics: ' +
              stringify({
                kind,
                action: 'waitFor',
                locator: selector,
                ...report,
                truncated: report.matchCount > report.matches.length,
              });
          } catch {}
          const failure = new ErrorClass(message + '\n' + details);
          if (error instanceof ErrorClass && error.stack)
            failure.stack = failure.name + ': ' + failure.message + '\n' + error.stack;
          throw failure;
        }
      },
      downloadMedia: async ({ timeoutMs } = {}) => {
        await invoke('browserDownloadMedia', {
          handle,
          target: { kind: 'locator', locator: { selector } },
          options: { timeoutMs },
        });
        collection?.cache.rows.clear();
      },
    };
    const result = Object.freeze(locatorTarget);
    locatorBindings.set(result, { identity, handle, selector });
    return result;
  };
  const frameFor = (selector) => {
    const descendant = (query) =>
      locatorFor(selector + ' >> internal:control=enter-frame >> ' + checkedSelector(query));
    const frameTarget = {
      ...queryBuilders(descendant),
      locator: descendant,
      frameLocator: (query) =>
        frameFor(selector + ' >> internal:control=enter-frame >> ' + checkedSelector(query)),
    };
    return Object.freeze(frameTarget);
  };
  const playwrightTarget = {
    ...queryBuilders((query) => locatorFor(query)),
    locator: (selector) => locatorFor(checkedSelector(selector)),
    frameLocator: (selector) => frameFor(checkedSelector(selector)),
    evaluate: (pageFunction, arg, options) =>
      evaluate(undefined, 'page', pageFunction, arg, options),
    domSnapshot: () => request('', { kind: 'domSnapshot' }),
    waitForURL: async (url, options = {}) => {
      if (!url) throw new ErrorClass('playwright.waitForURL requires a url');
      await invoke('browserWait', {
        handle,
        operation: { kind: 'url', url, waitUntil: options.waitUntil, timeoutMs: options.timeoutMs },
      });
    },
    waitForLoadState: async (options = {}) => {
      await invoke('browserWait', {
        handle,
        operation: { kind: 'loadState', state: options.state, timeoutMs: options.timeoutMs },
      });
    },
    waitForTimeout: async (timeoutMs) => {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0)
        throw new ErrorClass('playwright.waitForTimeout requires a non-negative integer');
      await invoke('browserWait', { handle, operation: { kind: 'timeout', timeoutMs } });
    },
    expectNavigation: async (action, options = {}) => {
      const navigation = options.url
        ? playwrightTarget.waitForURL(options.url, {
            timeoutMs: options.timeoutMs,
            waitUntil: options.waitUntil,
          })
        : playwrightTarget.waitForLoadState({
            timeoutMs: options.timeoutMs,
            state: options.waitUntil,
          });
      const [value] = await Promise.all([action(), navigation]);
      return value;
    },
    waitForEvent: async (event, options = {}) => {
      if (event !== 'download' && event !== 'filechooser')
        throw new ErrorClass("playwright.waitForEvent only supports 'download' and 'filechooser'");
      if (event === 'filechooser') {
        const result = await invoke('browserFileChooserWait', {
          handle,
          options: { timeoutMs: options?.timeoutMs },
        });
        return new PlaywrightFileChooser(handle, result.fileChooserId, result.isMultiple);
      }
      const result = await invoke('browserDownloadWait', {
        handle,
        options: { timeoutMs: options?.timeoutMs },
      });
      return new PlaywrightDownload(handle, result.downloadScope, result.downloadId);
    },
  };
  return Object.freeze(playwrightTarget);
};

let documented = false;
let reference;
const documentation = async () => {
  const text = await invoke('documentation');
  if (!documented || reference !== text) {
    reference = text;
    write(text);
    documented = true;
  }
  return text;
};
const observation = async (method, options = {}) => {
  const observed = await invoke(method, { options });
  const value = method === 'listTabs' ? observed.map(decodeTabMetadata)
    : method === 'getState' ? decodeBrowserState(observed) : observed;
  await documentation();
  if (options.emit !== false) write(value);
  else if (value?.errors?.length) write({ errors: value.errors });
  return value;
};
const nativeDirection = (value) => {
  if (nativePlatform === 'mac' && typeof value === 'string') value = value.trim().toLowerCase();
  switch (value) {
    case 'u':
      return 'up';
    case 'd':
      return 'down';
    case 'l':
      return 'left';
    case 'r':
      return 'right';
    default:
      return value;
  }
};
const nativeClickOptions = (options) => {
  if (options?.mouseButton === undefined) return options;
  let value = options.mouseButton;
  if (nativePlatform === 'mac') {
    if (typeof value === 'number') {
      if (value === 0) value = 'left';
      else if (value === 1) value = 'right';
      else if (value === 2) value = 'middle';
    } else if (typeof value === 'string') value = value.trim().toLowerCase();
  }
  switch (value) {
    case 'l':
      value = 'left';
      break;
    case 'r':
      value = 'right';
      break;
    case 'm':
      value = 'middle';
      break;
  }
  return { ...options, mouseButton: value };
};
const bind = async (method, args, document = true) => {
  const result = await invoke(method, args);
  if (result === null) return undefined;
  if (document) await documentation();
  const handle = result.handle;
  const observe = async (kind, options = {}, retainUnavailable = false) => {
    const value = await invoke('observe', { handle, kind, options });
    if (options.emit !== false) {
      if (value.state !== undefined) write(value.state);
      if (value.image) await emitImage(value.image);
    }
    const screenshot = value.image ? decode(value.image.data) : undefined;
    if (kind === 'screenshot' && screenshot === undefined)
      throw new ErrorClass('ax capture returned no screenshot data');
    const result =
      kind === 'ax'
        ? value.state
        : kind === 'screenshot'
          ? screenshot
          : screenshot === undefined
            ? { state: value.state }
            : { state: value.state, screenshot };
    return retainUnavailable ? { value: result, unavailable: value.screenshotUnavailable } : result;
  };
  const invokeAction = (kind, args) => {
    const pending = invoke('action', { handle, action: { kind, ...args } });
    if (nativePlatform !== 'linux' || result.kind !== 'app') return pending;
    return pending.catch((error) => {
      const message = error?.message;
      if (typeof message === 'string') {
        for (const prefix of ['tool failed: ', 'tool effect outcome unknown: ']) {
          if (message.startsWith(prefix)) throw new ErrorClass(message.slice(prefix.length));
        }
      }
      throw error;
    });
  };
  const action = (kind, args) =>
    invokeAction(kind, args).then((result) => {
      if (result?.warning) write(result.warning);
      if (['unverifiable', 'unchanged', 'partial', 'suspected_noop'].includes(result?.effect))
        write({
          effect: result.effect,
          route: result.route,
          delivery: result.delivery,
          requestedChars: result.requested_chars,
          deliveredChars: result.delivered_chars,
          warning: result.guidance,
        });
    });
  const target = {
    getAXState: (options) => observe('ax', options),
    getScreenshot: (options) => observe('screenshot', options),
    getAXStateAndScreenshot: (options) => observe('both', options),
    click: (target, options = {}) => action('click', { target, options }),
    drag: (from, to) => action('drag', { from, to }),
    scroll: (target, direction, distance) => action('scroll', { target, direction, distance }),
    setValue: (index, value) => action('setValue', { index, value }),
    selectText: (index, text, options = {}) => action('selectText', { index, text, options }),
    performSecondaryAction: (index, actionName) =>
      action('secondary', { index, action: actionName }),
  };
  if (result.kind === 'tab') {
    const readAx = async (mode, options) => {
      const kind = mode === 'state' ? 'ax' : mode === 'screenshot' ? 'screenshot' : 'both';
      const { value, unavailable } = await observe(
        kind,
        { disableDiffing: options?.disableDiffing, emit: false },
        true,
      );
      if (kind === 'ax' && typeof value !== 'string')
        throw new ErrorClass('ax capture returned no accessibility state');
      if (kind === 'both' && typeof value?.state !== 'string')
        throw new ErrorClass('ax capture returned no accessibility state');
      if (
        kind === 'both' &&
        value.screenshot === undefined &&
        (mode !== 'both' || typeof unavailable !== 'string')
      )
        throw new ErrorClass('ax capture returned no screenshot data');
      return { kind, value };
    };
    Object.assign(target, {
      id: result.id,
      ...(result.apiProfile?.mode === 'ax'
        ? {
            ax: Object.freeze({
              get: async (mode = 'state', options) => {
                const { value } = await readAx(mode, options);
                return ['state', 'screenshot', 'both'].includes(mode) ? value : undefined;
              },
              write: async (mode = 'state', options) => {
                const { kind, value } = await readAx(mode, options);
                if (kind === 'ax') write(value);
                else if (kind === 'screenshot') await emitImage(value);
                else {
                  write(value.state);
                  if (value.screenshot !== undefined) await emitImage(value.screenshot);
                }
              },
              click: (position, options) => target.click(position, options),
              drag: (from, to) => target.drag(from, to),
              paste: (index, text, options) =>
                target.paste(index, text, { format: options?.format }),
              performSecondaryAction: (index, name) => target.performSecondaryAction(index, name),
              pressKey: (index, key) => target.pressKey(index, key),
              scroll: (position, direction, pages) => target.scroll(position, direction, pages),
              selectText: (index, text, options) =>
                target.selectText(index, text, {
                  prefix: options?.prefix,
                  suffix: options?.suffix,
                  selectionType: options?.selectionType,
                }),
              setValue: (index, value) => target.setValue(index, value),
              typeText: (index, text) => target.typeText(index, text),
            }),
          }
        : {}),
      click: (position, options = {}) =>
        action('click', {
          target: position,
          options: nativeClickOptions({
            ...(options?.mouseButton === undefined ? {} : { mouseButton: options.mouseButton }),
            ...(options?.clickCount === undefined ? {} : { clickCount: options.clickCount }),
          }),
        }),
      playwright: playwrightFor(handle, result.id),
      cua: Object.freeze({
        type: async (input) => {
          if (typeof input?.text !== 'string') throw new ErrorClass('cua.type requires text');
          await invoke('browserCua', { handle, operation: { kind: 'type', text: input.text } });
        },
        keypress: async (input) => {
          if (!Array.isArray(input?.keys) || input.keys.length === 0)
            throw new ErrorClass('cua.keypress requires a non-empty keys array');
          await invoke('browserCua', { handle, operation: { kind: 'keypress', keys: input.keys } });
        },
        click: async (input) => {
          if (typeof input?.x !== 'number' || typeof input?.y !== 'number')
            throw new ErrorClass('cua.click requires x and y');
          await invoke('browserCua', {
            handle,
            operation: {
              kind: 'click',
              x: input.x,
              y: input.y,
              button: input.button,
              keys: input.keypress,
            },
          });
        },
        double_click: async (input) => {
          if (typeof input?.x !== 'number' || typeof input?.y !== 'number')
            throw new ErrorClass('cua.double_click requires x and y');
          await invoke('browserCua', {
            handle,
            operation: { kind: 'doubleClick', x: input.x, y: input.y, keys: input.keypress },
          });
        },
        drag: async (input) => {
          if (
            !Array.isArray(input?.path) ||
            input.path.length === 0 ||
            input.path.some((point) => typeof point?.x !== 'number' || typeof point?.y !== 'number')
          )
            throw new ErrorClass('cua.drag requires a non-empty path of {x, y} points');
          await invoke('browserCua', {
            handle,
            operation: { kind: 'drag', path: input.path, keys: input.keys },
          });
        },
        scroll: async (input) => {
          if (
            typeof input?.x !== 'number' ||
            typeof input?.y !== 'number' ||
            typeof input?.scrollX !== 'number' ||
            typeof input?.scrollY !== 'number'
          )
            throw new ErrorClass('cua.scroll requires x, y, scrollX, and scrollY');
          await invoke('browserCua', {
            handle,
            operation: {
              kind: 'scroll',
              x: input.x,
              y: input.y,
              scrollX: input.scrollX,
              scrollY: input.scrollY,
              keys: input.keypress,
            },
          });
        },
        move: async (input) => {
          if (typeof input?.x !== 'number' || typeof input?.y !== 'number')
            throw new ErrorClass('cua.move requires x and y');
          await invoke('browserCua', {
            handle,
            operation: { kind: 'move', x: input.x, y: input.y, keys: input.keys },
          });
        },
        downloadMedia: async (input) => {
          if (typeof input?.x !== 'number' || typeof input?.y !== 'number')
            throw new ErrorClass('cua.downloadMedia requires x and y');
          await invoke('browserDownloadMedia', {
            handle,
            target: { kind: 'coordinates', x: input.x, y: input.y },
            options: { timeoutMs: input.timeoutMs },
          });
        },
      }),
      dom_cua: Object.freeze({
        get_visible_dom: async () => {
          const packet = await invoke('browserCua', { handle, operation: { kind: 'domSnapshot' } });
          return parse(packet.json);
        },
        click: async (options) => {
          if (options?.node_id === undefined)
            throw new ErrorClass('dom_cua.click requires a node_id');
          if (typeof options.node_id !== 'string' || options.node_id.length === 0)
            throw new ErrorClass('dom_cua.click node_id must be a non-empty string');
          await invoke('browserCua', {
            handle,
            operation: { kind: 'domClick', node_id: options.node_id },
          });
        },
        double_click: async (options) => {
          if (options?.node_id === undefined)
            throw new ErrorClass('dom_cua.double_click requires a node_id');
          if (typeof options.node_id !== 'string' || options.node_id.length === 0)
            throw new ErrorClass('dom_cua.double_click node_id must be a non-empty string');
          await invoke('browserCua', {
            handle,
            operation: { kind: 'domDoubleClick', node_id: options.node_id },
          });
        },
        scroll: async ({ node_id, x, y }) => {
          if (typeof x !== 'number' || typeof y !== 'number')
            throw new ErrorClass('dom_cua.scroll requires x and y numbers');
          if (node_id !== undefined && (typeof node_id !== 'string' || node_id.length === 0))
            throw new ErrorClass('dom_cua.scroll node_id must be a non-empty string');
          await invoke('browserCua', {
            handle,
            operation: { kind: 'domScroll', node_id, scrollX: x, scrollY: y },
          });
        },

        type: async ({ text }) => {
          if (typeof text !== 'string') throw new ErrorClass('dom_cua.type requires text');
          await invoke('browserCua', { handle, operation: { kind: 'domType', text } });
        },
        keypress: async (input) => {
          if (!Array.isArray(input?.keys) || input.keys.length === 0)
            throw new ErrorClass('dom_cua.keypress requires a non-empty keys array');
          await invoke('browserCua', {
            handle,
            operation: { kind: 'domKeypress', keys: input.keys },
          });
        },
        downloadMedia: async (input) => {
          if (input?.node_id === undefined)
            throw new ErrorClass('dom_cua.downloadMedia requires a node_id');
          if (typeof input.node_id !== 'string' || input.node_id.length === 0)
            throw new ErrorClass('dom_cua.downloadMedia requires a nonempty node_id');
          await invoke('browserDownloadMedia', {
            handle,
            target: { kind: 'domNode', node_id: input.node_id },
            options: { timeoutMs: input.timeoutMs },
          });
        },
      }),
      screenshot: async (options = {}) => {
        const screenshotOptions = {};
        if (options.fullPage !== undefined) {
          if (typeof options.fullPage !== 'boolean')
            throw new ErrorClass('tab.screenshot fullPage must be a boolean');
          screenshotOptions.fullPage = options.fullPage;
        }
        if (options.clip) {
          const { x, y, width, height } = options.clip;
          if ([x, y, width, height].some((value) => typeof value !== 'number' || !Number.isFinite(value)))
            throw new ErrorClass('tab.screenshot clip requires x, y, width, and height');
          screenshotOptions.clip = { x, y, width, height };
        }
        const image = await invoke('browserScreenshot', { handle, options: screenshotOptions });
        return decode(image.data);
      },
      title: () => invoke('tabMetadata', { handle }).then((info) => decodeTabMetadata(info).title),
      url: () => invoke('tabMetadata', { handle }).then((info) => info.url),
      clipboard: Object.freeze({
        read: () => invoke('clipboardRead', { handle }),
        readText: () => invoke('clipboardReadText', { handle }),
        write: async (items) => {
          await invoke('clipboardWrite', { handle, items });
        },
        writeText: async (text) => {
          if (typeof text !== 'string') throw new ErrorClass('clipboard.writeText requires text');
          await invoke('clipboardWriteText', { handle, text });
        },
      }),
      getJsDialog: async () => {
        const metadata = await invoke('getJsDialog', { handle });
        if (metadata === null) return undefined;
        const dismiss = () =>
          invoke('handleJsDialog', {
            handle,
            dialogId: metadata.id,
            action: 'dismiss',
          }).then(() => undefined);
        const dialog = { type: metadata.type, dismiss };
        if (metadata.type === 'confirm')
          dialog.accept = () =>
            invoke('handleJsDialog', {
              handle,
              dialogId: metadata.id,
              action: 'accept',
            }).then(() => undefined);
        if (metadata.type === 'prompt')
          dialog.accept = (text) => {
            if (typeof text !== 'string') throw new ErrorClass('prompt.accept requires text');
            return invoke('handleJsDialog', {
              handle,
              dialogId: metadata.id,
              action: 'accept',
              promptText: text,
            }).then(() => undefined);
          };
        return Object.freeze(dialog);
      },
      typeText: (index, text) => action('typeText', { index, text }),
      paste: (index, text, options = {}) => action('paste', { index, text, options }),
      pressKey: (index, key) => action('pressKey', { index, key }),
      goto: (url) => action('navigate', { url }),
      back: () => action('back', {}),
      forward: () => action('forward', {}),
      reload: () => action('reload', {}),
      markHandoff: async () => {
        await invoke('browserMarkTab', { handle, status: 'handoff' });
      },
      markDeliverable: async () => {
        await invoke('browserMarkTab', { handle, status: 'deliverable' });
      },
      close: () => action('close', {}),
    });
  } else {
    if (nativePlatform === 'linux') {
      Object.assign(target, {
        click: (position, options = {}) => {
          const input = Array.isArray(position)
            ? { x: position[0], y: position[1] }
            : { element_id: String(position) };
          const projected = {};
          const mouseButton = options?.mouseButton;
          if (mouseButton !== undefined) projected.mouseButton = mouseButton;
          const clickCount = options?.clickCount;
          if (clickCount !== undefined) projected.clickCount = clickCount;
          const normalized = nativeClickOptions(projected);
          if (normalized.mouseButton !== undefined) input.mouse_button = normalized.mouseButton;
          if (normalized.clickCount !== undefined) input.click_count = normalized.clickCount;
          return action('linuxClick', { input: parse(stringify(input)) });
        },
        drag: (from, to) => {
          const input = {
            path: [
              { x: from[0], y: from[1] },
              { x: to[0], y: to[1] },
            ],
          };
          return action('linuxDrag', { input: parse(stringify(input)) });
        },
        scroll: (position, direction, distance) => {
          if (typeof distance === 'number')
            throw new ErrorClass('Linux scroll accepts { pixels }, not pages.');
          const input = { direction: nativeDirection(direction) };
          if (Array.isArray(position)) {
            input.x = position[0];
            input.y = position[1];
          } else input.element_id = String(position);
          if (distance !== undefined) input.pixels = distance.pixels;
          return action('linuxScroll', { input: parse(stringify(input)) });
        },
      });
    } else {
      Object.assign(target, {
        click: (position, options = {}) =>
          action('click', {
            target: position,
            options: nativeClickOptions(options),
          }),
        scroll: (position, direction, distance) =>
          action('scroll', {
            target: position,
            direction: nativeDirection(direction),
            distance,
          }),
      });
    }
    Object.assign(target, {
      typeText: (text) => action('typeText', { text }),
      paste: (text, options = {}) => action('paste', { text, options }),
      pressKey: (key) => action('pressKey', { key }),
    });
  }
  if (result.kind === 'tab') target.capabilities = tabCapabilities(result, handle);
  if (result.state !== undefined) write(result.state);
  return Object.freeze(target);
};
Object.defineProperty(globalThis, 'nodeRepl', {
  value: Object.freeze({
    write,
    emitImage,
    ...(audioEnabled ? { emitAudio } : {}),
  }),
});
// Add before the bound-tab factory. Metadata originates in the current Host.
const capabilityCollection = (infos, create) => {
  const entries = new Map();
  for (const info of infos ?? []) {
    const capability = create(info);
    if (capability) entries.set(info.id, Object.freeze(capability));
  }
  return Object.freeze({
    list: async () => [...entries.values()].map((capability) => capability.info),
    get: async (id) => {
      const found = entries.get(id);
      if (!found) throw new ErrorClass(`Capability is not available: ${id}`);
      return found;
    },
  });
};
const browserCapabilities = (result) =>
  capabilityCollection(result.capabilities?.browser, (info) => {
    if (info.id !== 'viewport') return undefined;
    return {
      id: info.id,
      info,
      documentation: () => invoke('readDocumentation', { name: 'capabilities/browser/viewport' }),
      set: async (options) => {
        await invoke('browserViewportSet', {
          browserId: result.id,
          options: { width: options?.width, height: options?.height },
        });
      },
      reset: async () => {
        await invoke('browserViewportReset', { browserId: result.id });
      },
    };
  });
const tabCapabilities = (result, handle) =>
  capabilityCollection(result.capabilities?.tab, (info) => {
    if (info.id !== 'pageAssets') return undefined;
    return {
      id: info.id,
      info,
      documentation: () => invoke('readDocumentation', { name: 'capabilities/tab/pageAssets' }),
      list: () => invoke('tabPageAssetsList', { handle }),
      bundle: (options) =>
        invoke('tabPageAssetsBundle', {
          handle,
          options: {
            inventoryId: options?.inventoryId,
            assetIds: options?.assetIds,
            kinds: options?.kinds,
          },
        }),
    };
  });

const browserHistoryOptions = (options = {}) => {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new ErrorClass('browser.history expects an options object');
  const result = {};
  if (options.queries != null) {
    if (
      !Array.isArray(options.queries) ||
      options.queries.length === 0 ||
      options.queries.some((query) => typeof query !== 'string')
    )
      throw new ErrorClass('browser.history received invalid queries');
    result.queries = options.queries;
  }
  if (options.limit != null) {
    if (!Number.isInteger(options.limit) || options.limit <= 0)
      throw new ErrorClass('browser.history received an invalid limit');
    result.limit = options.limit;
  }
  for (const key of ['from', 'to']) {
    if (options[key] == null) continue;
    const date = options[key] instanceof Date ? options[key] : new Date(options[key]);
    if (Number.isNaN(date.getTime()))
      throw new ErrorClass(`browser.history received an invalid ${key} date`);
    result[key] = date.toISOString();
  }
  return result;
};
const browserObject = (result) =>
  Object.freeze({
    browserId: result.id,
    capabilities: browserCapabilities(result),
    documentation: () => invoke('documentation'),
    nameSession: async (name) => {
      const trimmed = name.trim();
      if (!trimmed) throw new ErrorClass('browser.nameSession requires a name');
      await invoke('browserNameSession', { browserId: result.id, name: trimmed });
    },
    history: async (options = {}) =>
      invoke('browserHistory', {
        browserId: result.id,
        options: browserHistoryOptions(options),
      }),
    ...(result.apiProfile?.user === true
      ? {
          user: Object.freeze({
            openTabs: () => invoke('browserUserOpenTabs', { browserId: result.id }).then((rows) => rows.map(decodeTabMetadata)),
            getTabContext: async (tab) => {
              let id;
              if (typeof tab === 'string') {
                if (tab.length === 0)
                  throw new ErrorClass('browser.user.getTabContext received an empty tab id');
                id = tab;
              } else if (tab && typeof tab.id === 'string') id = tab.id;
              else
                throw new ErrorClass(
                  'browser.user.getTabContext expects a tab returned by browser.user.openTabs() or a tab id',
                );
              const context = await invoke('browserUserGetTabContext', {
                browserId: result.id,
                tabId: id,
              });
              if (context.kind !== 'document') return context;
              return {
                kind: context.kind,
                fileName: context.fileName,
                mimeType: context.mimeType,
                title: context.title,
                url: context.url,
                data: decode(context.dataBase64),
                ...(typeof context.path === 'string' ? { path: context.path } : {}),
              };
            },
            claimTab: (tab) => {
              let id;
              if (typeof tab === 'string') {
                if (tab.length === 0)
                  throw new ErrorClass('browser.user.claimTab received an empty tab id');
                id = tab;
              } else if (tab && typeof tab.id === 'string') id = tab.id;
              else throw new ErrorClass('browser.user.claimTab requires a listed tab or tab id');
              return bind('browserUserClaimTab', { browserId: result.id, tabId: id }, false);
            },
          }),
        }
      : {}),
    tabs: Object.freeze({
      list: () => invoke('browserManagedTabs', { browserId: result.id }).then((rows) => rows.map(decodeTabMetadata)),
      selected: () => bind('browserSelectedTab', { browserId: result.id }, false),
      get: async (id) => {
        if (!id) throw new ErrorClass('tabs.get requires a tab id');
        return bind(
          'browserTab',
          { browserId: result.id, reference: { kind: 'existing', id } },
          false,
        );
      },
      new: () => bind('browserTab', { browserId: result.id, reference: { kind: 'new' } }, false),
    }),
  });
const browsers = Object.freeze({
  list: async () =>
    (await invoke('listBrowsers', { options: {} })).map((row) => {
      const info = { ...row };
      delete info.apiProfile;
      delete info.capabilities;
      return info;
    }),
  get: async (id) => {
    if (!id) throw new ErrorClass('browsers.get requires a browser id');
    return browserObject(await invoke('getBrowser', { options: { id } }));
  },
  getDefault: async () =>
    browserObject(
      await invoke('browserSelect', {
        selection: { kind: 'default' },
      }),
    ),
  getForUrl: async (url) =>
    browserObject(
      await invoke('browserSelect', {
        selection: { kind: 'url', url },
      }),
    ),
});
Object.defineProperty(globalThis, 'agent', {
  value: Object.freeze({
    browsers,
    documentation: Object.freeze({
      get: async (name) => {
        try {
          return await invoke('readDocumentation', { name });
        } catch (error) {
          if (typeof name === 'string') {
            const missing = `Documentation is not available: ${name}`;
            if (error?.message === `tool failed: ${missing}`) throw new ErrorClass(missing);
          }
          throw error;
        }
      },
    }),
  }),
});
// Compose after existing nodeRepl setup and before cua registration. Factory
// and result-projector implementations are enclosed in this same lexical IIFE.
const rawNativeComputer = (() => {
// Private composition fragment. No provider, permission, or native implementation.
// installedMethods and audioSurface must come from the actual trusted Host.

const nonAudioMethods = Object.freeze({
  linux: Object.freeze([
    'perform_secondary_action', 'click', 'drag', 'drag_handle', 'activate_window',
    'get_screenshot', 'list_apps', 'list_windows', 'move', 'move_relative',
    'press_key', 'scroll', 'type_text', 'launch_app', 'get_window_state',
  ]),
  mac: Object.freeze([
    'list_apps', 'get_app_state', 'click', 'drag', 'paste',
    'perform_secondary_action', 'press_key', 'scroll', 'select_text',
    'set_value', 'type_text',
  ]),
  windows: Object.freeze([
    'activate_window', 'get_window_state', 'click', 'scroll', 'drag',
    'press_key', 'type_text', 'launch_app', 'list_apps', 'list_windows',
    'get_window', 'perform_secondary_action', 'set_value',
  ]),
});

function createNativeComputerSurface({
  platform, installedMethods, invoke, projectResult, newDragRequestId,
  audioSurface = {},
}) {
  if (!nonAudioMethods[platform] || !Array.isArray(installedMethods)
      || typeof invoke !== 'function' || typeof projectResult !== 'function') {
    throw new TypeError('native computer requires trusted Host installation metadata');
  }
  const client = { target: platform };
  for (const name of Object.keys(audioSurface)) {
    if (!['start_audio_recording', 'stop_audio_recording'].includes(name)
        || typeof audioSurface[name] !== 'function') {
      throw new TypeError('invalid existing Host audio surface');
    }
  }
  const call = (request) => invoke('nativeComputer', { call: request });
  for (const method of installedMethods) {
    if (['start_audio_recording', 'stop_audio_recording'].includes(method)) {
      if (typeof audioSurface[method] !== 'function') {
        throw new TypeError('installed audio method requires its existing Host service');
      }
      client[method] = audioSurface[method];
      continue;
    }
    if (!nonAudioMethods[platform].includes(method)) {
      throw new TypeError('installed native method disagrees with selected platform');
    }
    if (method === 'drag_handle') {
      if (typeof newDragRequestId !== 'function') {
        throw new TypeError('installed drag handle requires its Host request identity');
      }
      client[method] = () => {
        const handle = newDragRequestId();
        return {
          start: async (point) => {
            await call({ kind: 'drag_start', handle, point });
          },
          move_to: async (point) => {
            await call({ kind: 'drag_move', handle, point });
          },
          end: async () => {
            await call({ kind: 'drag_end', handle });
          },
        };
      };
    } else {
      client[method] = async (...args) => projectResult(
        method, await call({ kind: 'invoke', operation: method, args }),
      );
    }
  }
  return new Proxy({}, {
    get: (_target, key) => typeof client[key] === 'function'
      ? client[key].bind(client) : client[key],
    has: (_target, key) => key in client,
    ownKeys: () => Object.keys(client),
    getOwnPropertyDescriptor: (_target, key) => Object.getOwnPropertyDescriptor(client, key),
  });
}

// Raw results keep their platform shapes; no App-wrapper text reconstruction.

const textParts = (node) => {
  const seen = new Set();
  return [[undefined, node.name], ['Description', node.description], ['Value', node.value]]
    .filter(([, value]) => value !== undefined && value !== null && value.trim() && !seen.has(value) && seen.add(value))
    .map(([title, text]) => ({ title, text }));
};
const containers = new Set(['group', 'panel', 'filler', 'section', 'generic']);
const texts = new Set(['text', 'static', 'label']);
const interactiveRoles = new Set(['push button', 'button', 'toggle button', 'check box',
  'radio button', 'entry', 'password text', 'link', 'menu item', 'check menu item',
  'radio menu item', 'combo box', 'slider', 'spin button', 'scroll bar', 'scroll pane', 'viewport']);
const interactiveStates = new Set(['focusable', 'focused', 'editable', 'selected',
  'checkable', 'checked', 'indeterminate', 'expanded']);
const decorativeActions = new Set(['dodefault', 'clickancestor', 'showcontextmenu', 'scrolltovisible']);
const interactive = (node) => interactiveRoles.has(node.role)
  || node.states?.some((state) => interactiveStates.has(state))
  || node.actions?.some((action) => !decorativeActions.has(action.toLowerCase()));
const content = (node) => textParts(node).length > 0 || ['image', 'icon'].includes(node.role);
const containsInteractive = (node) => interactive(node) || node.children.some(containsInteractive);

function view(input) {
  const node = { ...input, children: input.children.map(view).filter(Boolean) };
  const live = interactive(node);
  if (!content(node) && !node.children.length && !(node.native_id ?? node.id).startsWith('x11:')
      && !(live && (!node.states || node.states.includes('enabled') || node.states.includes('focused')))) {
    return undefined;
  }
  if (!live && !content(node) && containers.has(node.role)) {
    if (node.children.length === 1) return node.children[0];
    node.children = node.children.flatMap((child) => child.role === node.role
      && !interactive(child) && !content(child) ? child.children : [child]);
  }
  if (!node.children.some(containsInteractive)) {
    const own = textParts(node).map(({ text }) => text);
    for (;;) {
      let removed = false;
      node.children = node.children.flatMap((child) => {
        const parts = textParts(child);
        if (texts.has(child.role) && parts.length && parts.every(({ text }) => own.some((value) => value.includes(text)))) {
          removed = true;
          return child.children;
        }
        return [child];
      });
      if (!removed) break;
    }
  }
  if (!live) {
    const merged = [];
    let adjacent = [];
    const flush = () => {
      if (adjacent.length === 1) merged.push(adjacent[0]);
      else if (adjacent.length) merged.push({ ...adjacent[0], role: 'text', name: undefined,
        description: undefined, value: adjacent.flatMap(textParts).map(({ text }) => text).join(' ') });
      adjacent = [];
    };
    for (const child of node.children) {
      if (texts.has(child.role) && !interactive(child) && !child.children.length) adjacent.push(child);
      else { flush(); merged.push(child); }
    }
    flush();
    node.children = merged;
  }
  return node;
}

function description(node) {
  const states = node.states;
  const flags = ['focused', 'selected', 'expanded', 'indeterminate'].filter((state) => states?.includes(state));
  if (states?.includes('checked')) flags.push('checked');
  else if (states?.includes('checkable') && !states.includes('indeterminate')) flags.push('unchecked');
  if (states?.includes('editable')) flags.push('settable');
  if (states && !states.includes('enabled') && !containers.has(node.role) && !texts.has(node.role)) flags.push('disabled');
  const parts = textParts(node);
  const context = node.actions?.filter((action) => action.toLowerCase() === 'showcontextmenu').length === 1;
  const actions = node.actions?.filter((action, index) => !(index === 0
    && ['press', 'click', 'dodefault', 'clickancestor'].includes(action.toLowerCase()))
    && !(context && action.toLowerCase() === 'showcontextmenu'));
  if (actions?.length) parts.push({ title: 'Secondary Actions', text: actions.join(', ') });
  const long = (text) => text.length > 100 || text.includes('\n');
  parts.sort((left, right) => Number(long(left.text)) - Number(long(right.text)));
  const values = parts.map(({ title, text }) => !title || parts.length === 1 && title !== 'Secondary Actions'
    ? text : `${title}: ${text}`).join(', ');
  const role = containers.has(node.role) ? 'container' : texts.has(node.role) ? 'text'
    : node.role === 'menu item' ? '' : node.role;
  return [role, flags.length ? `(${flags.join(', ')})` : '', values].filter(Boolean).join(' ')
    .replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\t', '\\t');
}

function treeText() {
  const root = view(this);
  if (!root) return '';
  const lines = [];
  const append = (node, depth) => {
    lines.push(`${'\t'.repeat(depth)}${node.id} ${description(node)}`);
    for (const child of node.children) append(child, depth + 1);
  };
  append(root, 0);
  return lines.join('\n');
}

function decorateLinuxTree(node) {
  for (const child of node.children) decorateLinuxTree(child);
  Object.defineProperties(node, {
    to_string: { value: treeText, configurable: true },
    [Symbol.for('nodejs.util.inspect.custom')]: { value: treeText, configurable: true },
  });
  return node;
}

const valueMethods = new Set(['list_apps', 'list_windows', 'get_window', 'get_screenshot',
  'get_window_state', 'get_app_state']);

function nativeResultProjector({ platform, decode, emitImage }) {
  const screenshot = (value) => ({ filepath: value.filepath,
    bytes: decode(value.data_url.split(',')[1] ?? ''), data_url: value.data_url });
  return async (method, value) => {
    if (!valueMethods.has(method)) return undefined;
    if (platform === 'linux' && method === 'get_screenshot') return value.map(screenshot);
    if (platform === 'linux' && method === 'get_window_state') return {
      ...value, ax_tree: decorateLinuxTree(value.ax_tree), screenshots: value.screenshots.map(screenshot),
    };
    if (platform === 'windows' && method === 'get_window_state') {
      for (const image of value.screenshots) await emitImage(image.url);
    }
    return value;
  };
}


  let dragSequence = 0;
  const audioSurface = audioEnabled ? {
    // Reuse the existing Host audio permission, recording and completion path.
    start_audio_recording: async (options = {}) => {
      await documentation();
      await invoke('startAudioRecording', { options });
    },
    stop_audio_recording: async () => {
      await documentation();
      const result = await invoke('stopAudioRecording');
      const content = audio(result.data_url);
      return { filepath: result.filepath, bytes: decode(content.data), data_url: result.data_url };
    },
  } : {};
  if (!nonAudioMethods[nativePlatform]) return Object.freeze({ target: nativePlatform, ...audioSurface });
  return createNativeComputerSurface({
    platform: nativePlatform,
    installedMethods: [...nonAudioMethods[nativePlatform], ...Object.keys(audioSurface)],
    invoke,
    projectResult: nativeResultProjector({ platform: nativePlatform, decode, emitImage }),
    // This is data identity scoped to this VM/Host epoch, never permission.
    // End removes the native handle so start may later reuse this JS object.
    newDragRequestId: () => `maka-raw-drag-${++dragSequence}`,
    audioSurface,
  });
})();
// Existing cua registration replaces only its computer field with:
//   computer: rawNativeComputer,


Object.defineProperty(globalThis, 'cua', {
  value: Object.freeze({
    computer: rawNativeComputer,
    cursor: Object.freeze({
      configure: (options = {}) => invoke('configureCursor', { options }),
      getState: () => observation('cursorState'),
    }),
    getState: (options) => observation('getState', options),
    listApps: (options) => observation('listApps', options),
    listWindows: (options) => observation('listWindows', options),
    getApp: (target) => bind('getApp', { target }),
    listBrowsers: (options) => observation('listBrowsers', options),
    listTabs: (options) => observation('listTabs', options),
    browsers,
    getBrowser: async (options = {}) => {
      let id = options?.id;
      if (options?.extensionInstanceId !== undefined) {
        if (id !== undefined)
          throw new ErrorClass('Specify either id or extensionInstanceId, not both.');
        const matching = (await browsers.list()).filter(
          (row) =>
            row.type === 'extension' &&
            row.metadata?.extensionInstanceId === options.extensionInstanceId,
        );
        if (matching.length === 0) throw new ErrorClass('The Chrome instance is unavailable.');
        if (matching.length !== 1)
          throw new ErrorClass(
            `Multiple browsers match the Chrome instance: ${stringify(matching)}`,
          );
        id = matching[0].id;
      }
      const url = options?.url;
      let browser;
      if (id !== undefined) browser = await browsers.get(id);
      else if (url !== undefined) {
        let normalized;
        try {
          normalized = new URL(url).href;
        } catch {
          normalized = `https://${url}`;
        }
        browser = await browsers.getForUrl(normalized);
      } else browser = await browsers.getDefault();
      await documentation();
      return browser;
    },
    getTab: (reference, options = {}) => bind('getTab', { reference, options }),
    createBrowserTab: async (browserId, url, options = {}) => {
      if (typeof browserId !== 'string' || !browserId.trim())
        throw new ErrorClass(
          'createBrowserTab requires a browser ID. Select one with cua.getBrowser().',
        );
      const browser = await browsers.get(browserId);
      if (options?.sessionName !== undefined) await browser.nameSession(options.sessionName);
      if (options?.visible !== undefined)
        throw new ErrorClass('Capability is not available: visibility');
      return bind('createBrowserTab', {
        browserId: browser.browserId,
        url,
        options: { ...(options?.visible === undefined ? {} : { visible: options.visible }) },
      });
    },
    rewriteDocumentation: async () => {
      documented = false;
      return documentation();
    },
  }),
});
