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
      if (event !== 'download')
        throw new ErrorClass("playwright.waitForEvent only supports 'download' and 'filechooser'");
      const result = await invoke('browserDownloadWait', {
        handle,
        options: { timeoutMs: options.timeoutMs },
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
  const value = await invoke(method, { options });
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
const bind = async (method, args) => {
  const result = await invoke(method, args);
  await documentation();
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
      title: () => invoke('tabMetadata', { handle }).then((info) => info.title),
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
Object.defineProperty(globalThis, 'cua', {
  value: Object.freeze({
    computer: Object.freeze({
      target: nativePlatform,
      ...(audioEnabled
        ? {
            start_audio_recording: async (options = {}) => {
              await documentation();
              await invoke('startAudioRecording', { options });
            },
            stop_audio_recording: async () => {
              await documentation();
              const result = await invoke('stopAudioRecording');
              const content = audio(result.data_url);
              return {
                filepath: result.filepath,
                bytes: decode(content.data),
                data_url: result.data_url,
              };
            },
          }
        : {}),
      ...(nativePlatform === 'windows'
        ? {
            launch_app: (input) => invoke('launchApp', { app: input.app }).then(() => {}),
          }
        : {}),
    }),
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
    getBrowser: async (options = {}) => {
      const result = await invoke('getBrowser', { options });
      await documentation();
      return Object.freeze({
        browserId: result.id,
        documentation,
        ...(result.apiProfile?.user === true
          ? {
              user: Object.freeze({
                openTabs: () => invoke('browserUserOpenTabs', { browserId: result.id }),
                claimTab: (tab) => {
                  let id;
                  if (typeof tab === 'string') {
                    if (tab.length === 0)
                      throw new ErrorClass('browser.user.claimTab received an empty tab id');
                    id = tab;
                  } else if (tab && typeof tab.id === 'string') id = tab.id;
                  else
                    throw new ErrorClass('browser.user.claimTab requires a listed tab or tab id');
                  return bind('browserUserClaimTab', { browserId: result.id, tabId: id });
                },
              }),
            }
          : {}),
        tabs: Object.freeze({
          list: () => invoke('browserManagedTabs', { browserId: result.id }),
          get: (id) =>
            bind('browserTab', {
              browserId: result.id,
              reference: { kind: 'existing', id },
            }),
          new: () =>
            bind('browserTab', {
              browserId: result.id,
              reference: { kind: 'new' },
            }),
        }),
      });
    },
    getTab: (reference, options = {}) => bind('getTab', { reference, options }),
    createBrowserTab: (browserId, url, options = {}) =>
      bind('createBrowserTab', { browserId, url, options }),
    rewriteDocumentation: async () => {
      documented = false;
      return documentation();
    },
  }),
});
