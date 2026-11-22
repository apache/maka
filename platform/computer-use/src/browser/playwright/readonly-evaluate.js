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

// Evaluated only in the browser's dedicated isolated world. Raw DOM objects
// remain closure-owned; evaluated code receives fixed frozen read surfaces.
function evaluateReadonly(script, mode, selection) {
  if (/\bimport\b(?:(?:\s+)|(?:\/\/[^\n\r]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/))*\(/u.test(script))
    throw new Error('module loading is not available in playwright.evaluate');
  const rawWindow = globalThis;
  const compile = Function;
  const rawDocument = rawWindow.document;
  const token = {};
  const rawByView = new WeakMap();
  const viewByRaw = new WeakMap();
  const specialViews = new WeakSet();
  const nodeViews = new WeakSet();
  const error = (name) => new Error(`${name} is not available in playwright.evaluate because the DOM is read-only`);
  const hidden = (target, name, value) => Object.defineProperty(target, name,
    { value, writable: false, enumerable: false, configurable: false });
  const field = (target, name, value) => Object.defineProperty(target, name,
    { value, writable: false, enumerable: true, configurable: false });
  const getter = (target, name, get) => Object.defineProperty(target, name,
    { get, enumerable: false, configurable: false });
  const list = (items, extras = {}) => {
    const result = Array.from(items ?? []);
    hidden(result, 'constructor', undefined);
    hidden(result, 'item', (index) => result[index] ?? null);
    for (const [key, value] of Object.entries(extras)) hidden(result, key, value);
    return Object.freeze(result);
  };
  const raw = (view) => view != null && ['object', 'function'].includes(typeof view)
    ? rawByView.get(view) ?? null : null;
  const requireRaw = (view, type, operation) => {
    const value = nodeViews.has(view) ? raw(view) : null;
    if (value == null || type === 'Element' && value.nodeType !== 1)
      throw new TypeError(`${operation} expects ${type === 'Element' ? 'an' : 'a'} ${type}`);
    return value;
  };
  const attach = (view, value, supplied, label = 'Node') => {
    if (supplied !== token) throw error(`${label} constructor`);
    rawByView.set(view, value);
    hidden(view, 'constructor', undefined);
  };
  const cache = (value, create) => {
    if (value == null) return null;
    let view = viewByRaw.get(value);
    if (view === undefined) { view = create(value); viewByRaw.set(value, view); }
    return view;
  };
  const protectedField = (element) => {
    if (String(element.tagName).toLowerCase() !== 'input') return false;
    if (element.getAttribute('type')?.toLowerCase() === 'hidden') return true;
    const description = ['type', 'autocomplete', 'id', 'name', 'placeholder', 'aria-label', 'title']
      .map((name) => element.getAttribute(name) ?? '').join(' ');
    return /user[-_ ]?name|e[-_ ]?mail|one[-_ ]?time[-_ ]?code|password|passcode|passwd|\botp\b|\b(?:2fa|mfa)\b|phone|mobile|\btel\b/i.test(description);
  };
  const attribute = (item) => Object.freeze({ name: item.name, nodeName: item.name,
    nodeValue: item.value, specified: true, value: item.value });
  const attributes = (element) => {
    const protect = protectedField(element), source = element.attributes;
    return list(Array.from(source).filter((item) => !protect || item.name.toLowerCase() !== 'value').map(attribute), {
      getNamedItem(name) {
        name = String(name);
        if (protect && name.toLowerCase() === 'value') return null;
        const item = source.getNamedItem(name);
        return item == null ? null : attribute(item);
      },
    });
  };
  const html = (node, outer) => {
    const markup = outer ? node.outerHTML : node.innerHTML;
    if (typeof markup !== 'string') return '';
    const hasSecret = (element) => element.hasAttribute('value') && protectedField(element);
    if (!(outer && hasSecret(node)) && !Array.from(node.querySelectorAll('input[value]')).some(hasSecret)) return markup;
    const template = node.ownerDocument.createElement('template');
    for (const child of outer ? [node] : Array.from(node.childNodes))
      template.content.append(template.content.ownerDocument.importNode(child, true));
    for (const element of template.content.querySelectorAll('input[value]'))
      if (hasSecret(element)) element.removeAttribute('value');
    return template.innerHTML;
  };
  const rect = (value) => {
    const project = () => Object.fromEntries(['bottom', 'height', 'left', 'right', 'top', 'width', 'x', 'y'].map((name) => [name, value[name]]));
    return Object.freeze({ ...project(), toJSON: project });
  };
  const rects = (items) => list(Array.from(items, rect));
  const tokens = (value) => value == null ? undefined : list(Array.from(value, String), {
    contains: (item) => value.contains(String(item)), item: (index) => value.item(index), value: value.value,
  });
  const times = (value) => {
    if (value == null) return undefined;
    return list(Array.from({ length: value.length }, (_, index) => Object.freeze({ start: value.start(index), end: value.end(index) })),
      { start: (index) => value.start(Number(index)), end: (index) => value.end(Number(index)) });
  };
  const tracks = (value) => {
    if (value == null) return undefined;
    const rows = Array.from(value, (track) => Object.freeze({
      enabled: track.enabled === true, id: typeof track.id === 'string' ? track.id : '',
      kind: typeof track.kind === 'string' ? track.kind : '', label: typeof track.label === 'string' ? track.label : '',
      language: typeof track.language === 'string' ? track.language : '',
      mode: typeof track.mode === 'string' ? track.mode : undefined, selected: track.selected === true,
    }));
    return list(rows, { getTrackById: (id) => rows.find((track) => track.id === String(id)) ?? null });
  };
  const nodeList = (source) => {
    const values = Array.from(source ?? []);
    return list(values.map(node), { namedItem(name) {
      name = String(name);
      const result = typeof source?.namedItem === 'function' ? source.namedItem(name)
        : values.find((item) => item?.id === name || item?.name === name) ?? null;
      return result == null ? null : typeof result.nodeType === 'number' ? node(result)
        : ['object', 'function'].includes(typeof result) && typeof result.length === 'number' ? nodeList(result) : null;
    } });
  };
  const jsonKeys = (view, names) => Object.fromEntries(names.map((name) => [name, view[name]]));
  const install = (type, keys, transform = (value) => value) => {
    for (const key of keys.split(' ').filter(Boolean)) getter(type.prototype, key,
      function () { return transform(raw(this)[key], key, raw(this), this); });
  };

  class ReadonlyNode {
    constructor(value, supplied) { attach(this, value, supplied); nodeViews.add(this); if (new.target === ReadonlyNode) Object.freeze(this); }
    contains(other) { const value = nodeViews.has(other) ? raw(other) : null; return value != null && raw(this).contains(value); }
    getRootNode(options) { const value = raw(this); return node(typeof value.getRootNode === 'function'
      ? value.getRootNode(options) : value.ownerDocument ?? rawDocument); }
    toJSON() { return jsonKeys(this, ['name', 'nodeName', 'nodeType', 'publicId', 'systemId', 'textContent']); }
  }
  install(ReadonlyNode, 'nodeName nodeType nodeValue textContent');
  install(ReadonlyNode, 'name publicId systemId', (value) => typeof value === 'string' ? value : undefined);
  install(ReadonlyNode, 'isConnected', (value) => value === true);
  install(ReadonlyNode, 'firstChild lastChild nextSibling parentElement parentNode previousSibling', node);
  install(ReadonlyNode, 'ownerDocument', (value) => node(value ?? rawDocument));
  install(ReadonlyNode, 'childNodes', nodeList);

  class ReadonlyElement extends ReadonlyNode {
    constructor(value, supplied) { super(value, supplied); Object.freeze(this); }
    closest(selector) { return node(raw(this).closest(String(selector))); }
    getAttribute(name) { name = String(name); return protectedField(raw(this)) && name.toLowerCase() === 'value'
      ? null : raw(this).getAttribute(name); }
    hasAttribute(name) { return raw(this).hasAttribute(String(name)); }
    matches(selector) { return raw(this).matches(String(selector)); }
    querySelector(selector) { return node(raw(this).querySelector(String(selector))); }
    querySelectorAll(selector) { return nodeList(raw(this).querySelectorAll(String(selector))); }
    getElementsByClassName(name) { return nodeList(raw(this).getElementsByClassName(String(name))); }
    getElementsByTagName(name) { return nodeList(raw(this).getElementsByTagName(String(name))); }
    getBoundingClientRect() { return rect(raw(this).getBoundingClientRect()); }
    getClientRects() { return rects(raw(this).getClientRects()); }
    scroll(leftOrOptions, top) { return this.scrollTo(leftOrOptions, top); }
    scrollTo(leftOrOptions, top) { const value = raw(this); if (typeof value.scrollTo !== 'function') return;
      if (scrollOptions(leftOrOptions)) value.scrollTo({ ...leftOrOptions }); else value.scrollTo(Number(leftOrOptions ?? 0), Number(top ?? 0)); }
    scrollBy(leftOrOptions, top) { const value = raw(this); if (typeof value.scrollBy !== 'function') return;
      if (scrollOptions(leftOrOptions)) value.scrollBy({ ...leftOrOptions }); else value.scrollBy(Number(leftOrOptions ?? 0), Number(top ?? 0)); }
    scrollIntoView(options) { const value = raw(this); if (typeof value.scrollIntoView !== 'function') return;
      value.scrollIntoView(options == null || typeof options === 'boolean' ? options : scrollOptions(options) ? { ...options } : Boolean(options)); }
    toJSON() { return jsonKeys(this, ['id', 'tagName', 'textContent']); }
  }
  install(ReadonlyElement, 'id innerText localName namespaceURI tagName');
  install(ReadonlyElement, 'ariaChecked ariaControls ariaCurrent ariaDescribedBy ariaDescription ariaDisabled ariaExpanded ariaHasPopup ariaHidden ariaInvalid ariaLabel ariaLabelledBy ariaPressed ariaSelected ariaSort ariaValueMax ariaValueMin ariaValueNow ariaValueText crossOrigin role selectionDirection',
    (value) => typeof value === 'string' ? value : null);
  install(ReadonlyElement, 'alt action allow as autocomplete decoding dir download currentSrc enctype exportparts formAction formEnctype formMethod formTarget hash fetchPriority host hostname href hreflang httpEquiv htmlFor label lang loading media max method min name origin pathname pattern ping placeholder port poster protocol referrerPolicy rel search sizes slot src srcdoc srcset step target title type',
    (value) => typeof value === 'string' ? value : '');
  install(ReadonlyElement, 'async autoplay checked controls defaultSelected defer defaultMuted disabled complete ended formNoValidate hidden loop multiple muted noValidate open paused readOnly required selected willValidate', (value) => value === true);
  install(ReadonlyElement, 'clientHeight clientLeft clientTop clientWidth currentTime duration height length naturalHeight naturalWidth offsetHeight offsetLeft offsetTop offsetWidth readyState scrollHeight scrollLeft scrollTop scrollWidth size videoHeight videoWidth width', (value) => value ?? 0);
  install(ReadonlyElement, 'cellIndex index maxLength minLength rowIndex sectionRowIndex selectedIndex tabIndex', (value) => value ?? -1);
  install(ReadonlyElement, 'colSpan defaultPlaybackRate playbackRate rowSpan', (value) => value ?? 1);
  install(ReadonlyElement, 'selectionEnd selectionStart', (value) => value ?? null);
  install(ReadonlyElement, 'assignedSlot caption firstElementChild form lastElementChild list nextElementSibling previousElementSibling shadowRoot tFoot tHead', node);
  install(ReadonlyElement, 'children cells elements labels options rows selectedOptions tBodies', nodeList);
  install(ReadonlyElement, 'classList part relList sandbox', tokens);
  install(ReadonlyElement, 'buffered played seekable', times);
  install(ReadonlyElement, 'audioTracks textTracks videoTracks', tracks);
  install(ReadonlyElement, 'attributes', (_value, _key, element) => attributes(element));
  install(ReadonlyElement, 'dataset', (value) => {
    const result = Object.create(null);
    for (const name of Object.keys(value)) field(result, name, value[name]);
    hidden(result, 'constructor', undefined);
    return Object.freeze(result);
  });
  install(ReadonlyElement, 'className', (value) => typeof value === 'string' ? value : typeof value?.baseVal === 'string' ? value.baseVal : '');
  install(ReadonlyElement, 'content', (value) => value != null && typeof value === 'object' && 'nodeType' in value ? node(value) : value);
  install(ReadonlyElement, 'innerHTML outerHTML', (_value, key, element) => html(element, key === 'outerHTML'));
  install(ReadonlyElement, 'defaultValue validationMessage value', (value, _key, element) => !protectedField(element) && typeof value === 'string' ? value : '');
  install(ReadonlyElement, 'valueAsNumber', (value, _key, element) => protectedField(element) ? null : value ?? null);
  install(ReadonlyElement, 'text', (value, _key, _element, view) => typeof value === 'string' ? value : view.textContent);
  install(ReadonlyElement, 'style', style);
  install(ReadonlyElement, 'validity', (value) => value == null ? undefined : Object.freeze(Object.fromEntries(
    'badInput customError patternMismatch rangeOverflow rangeUnderflow stepMismatch tooLong tooShort typeMismatch valid valueMissing'.split(' ').map((key) => [key, value[key] === true]))));
  install(ReadonlyElement, 'assignedElements assignedNodes', (value, key, element) => typeof value !== 'function' ? undefined
    : (options = {}) => list(Array.from(element[key]({ flatten: options.flatten === true }), node)));

  class ReadonlyDocumentFragment extends ReadonlyNode {
    constructor(value, supplied) { super(value, supplied); Object.freeze(this); }
    getElementById(id) { return node(raw(this).getElementById(String(id))); }
    querySelector(selector) { return node(raw(this).querySelector(String(selector))); }
    querySelectorAll(selector) { return nodeList(raw(this).querySelectorAll(String(selector))); }
  }
  install(ReadonlyDocumentFragment, 'activeElement firstElementChild host lastElementChild', node);
  install(ReadonlyDocumentFragment, 'children', nodeList);
  install(ReadonlyDocumentFragment, 'childElementCount', (value, _key, _raw, view) => value ?? view.children.length);
  install(ReadonlyDocumentFragment, 'innerHTML', (_value, _key, value) => html(value, false));
  install(ReadonlyDocumentFragment, 'mode', (value) => typeof value === 'string' ? value : undefined);
  install(ReadonlyDocumentFragment, 'styleSheets adoptedStyleSheets', (value) => list(Array.from(value ?? [], sheet)));

  class ReadonlyDocument extends ReadonlyNode {
    constructor(value, supplied) { super(value, supplied); Object.freeze(this); }
    elementFromPoint(x, y) { const value = raw(this); return typeof value.elementFromPoint === 'function' ? node(value.elementFromPoint(Number(x), Number(y))) : null; }
    elementsFromPoint(x, y) { const value = raw(this); return nodeList(typeof value.elementsFromPoint === 'function' ? value.elementsFromPoint(Number(x), Number(y)) : []); }
    createRange() { return range(raw(this).createRange()); }
    getElementById(id) { return node(raw(this).getElementById(String(id))); }
    getElementsByClassName(name) { return nodeList(raw(this).getElementsByClassName(String(name))); }
    getElementsByName(name) { return nodeList(raw(this).getElementsByName(String(name))); }
    getElementsByTagName(name) { return nodeList(raw(this).getElementsByTagName(String(name))); }
    querySelector(selector) { return node(raw(this).querySelector(String(selector))); }
    querySelectorAll(selector) { return nodeList(raw(this).querySelectorAll(String(selector))); }
  }
  install(ReadonlyDocument, 'activeElement body doctype documentElement head scrollingElement', node);
  install(ReadonlyDocument, 'forms images links scripts', nodeList);
  install(ReadonlyDocument, 'characterSet contentType compatMode lastModified readyState referrer title URL visibilityState');
  install(ReadonlyDocument, 'hidden', (value) => value === true);
  getter(ReadonlyDocument.prototype, 'cookie', () => undefined);
  install(ReadonlyDocument, 'defaultView', () => windowView);
  install(ReadonlyDocument, 'location', () => locationView);
  install(ReadonlyDocument, 'fonts', fonts);
  install(ReadonlyDocument, 'styleSheets adoptedStyleSheets', (value) => list(Array.from(value ?? [], sheet)));
  function node(value) {
    return cache(value, (item) => new (item.nodeType === 9 ? ReadonlyDocument : item.nodeType === 1
      ? ReadonlyElement : item.nodeType === 11 ? ReadonlyDocumentFragment : ReadonlyNode)(item, token));
  }

  class ReadonlyStyleDeclaration {
    constructor(value, supplied) { attach(this, value, supplied, 'CSSStyleDeclaration'); Object.freeze(this); }
    getPropertyValue(name) { return raw(this).getPropertyValue(String(name)); }
    getPropertyPriority(name) { return raw(this).getPropertyPriority(String(name)); }
    item(index) { return raw(this).item(Number(index)) ?? ''; }
    *[Symbol.iterator]() { for (let index = 0; index < this.length; index++) yield this.item(index); }
    toJSON() { const result = {}; for (let index = 0; index < Math.min(this.length, 200); index++) {
      const name = this.item(index); result[name] = this.getPropertyValue(name);
    } return result; }
  }
  install(ReadonlyStyleDeclaration, 'length');
  install(ReadonlyStyleDeclaration, 'cssText', (value) => value ?? '');
  function style(value) {
    const target = new ReadonlyStyleDeclaration(value, token);
    const view = new Proxy(target, {
      get(object, key, receiver) {
        if (key === Symbol.toStringTag) return 'CSSStyleDeclaration';
        if (key === Symbol.iterator) return object[Symbol.iterator].bind(object);
        if (typeof key === 'string') {
          if (/^\d+$/u.test(key)) return object.item(Number(key));
          if (key in object) { const result = Reflect.get(object, key, object); return typeof result === 'function' ? result.bind(object) : result; }
          if (typeof value[key] === 'function') return undefined;
          return object.getPropertyValue(key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)) || object.getPropertyValue(key);
        }
        return Reflect.get(object, key, receiver);
      },
      set() { throw error('CSSStyleDeclaration assignment'); },
    });
    specialViews.add(view);
    return view;
  }
  class ReadonlyMediaList {
    constructor(value, supplied) { attach(this, value, supplied, 'MediaList'); Object.freeze(this); }
    item(index) { return raw(this).item(Number(index)) ?? ''; }
    *[Symbol.iterator]() { for (let index = 0; index < this.length; index++) yield this.item(index); }
    toJSON() { return Array.from(this); }
  }
  install(ReadonlyMediaList, 'length mediaText');
  function media(value) { return cache(value, (item) => {
    const result = new ReadonlyMediaList(item, token); specialViews.add(result); return result;
  }); }
  class ReadonlyCSSRule {
    constructor(value, supplied) { attach(this, value, supplied, 'CSSRule'); Object.freeze(this); }
    toJSON() {
      const result = jsonKeys(this, ['cssText', 'type']);
      for (const name of ['conditionText', 'href', 'keyText', 'name', 'selectorText']) if (this[name] !== undefined) result[name] = this[name];
      if (this.style !== undefined) result.style = this.style.toJSON();
      return result;
    }
  }
  install(ReadonlyCSSRule, 'conditionText href keyText name selectorText', (value) => typeof value === 'string' ? value : undefined);
  install(ReadonlyCSSRule, 'cssText type');
  install(ReadonlyCSSRule, 'cssRules', (value, _key, item) => 'cssRules' in item ? list(Array.from(value, rule)) : undefined);
  install(ReadonlyCSSRule, 'media', (value, _key, item) => 'media' in item ? media(value) : undefined);
  install(ReadonlyCSSRule, 'parentRule', rule);
  install(ReadonlyCSSRule, 'parentStyleSheet styleSheet', sheet);
  install(ReadonlyCSSRule, 'style', (value) => value == null ? undefined : style(value));
  function rule(value) { return cache(value, (item) => {
    const result = new ReadonlyCSSRule(item, token); specialViews.add(result); return result;
  }); }
  class ReadonlyCSSStyleSheet {
    constructor(value, supplied) { attach(this, value, supplied, 'CSSStyleSheet'); Object.freeze(this); }
    toJSON() {
      const result = { disabled: this.disabled, href: this.href, media: this.media?.toJSON() ?? null, title: this.title, type: this.type };
      try { result.ruleCount = this.cssRules.length; }
      catch (caught) { result.ruleAccessError = caught instanceof Error ? caught.name || caught.message : String(caught); }
      return result;
    }
  }
  install(ReadonlyCSSStyleSheet, 'cssRules', (value) => list(Array.from(value, rule)));
  install(ReadonlyCSSStyleSheet, 'disabled', (value) => value === true);
  install(ReadonlyCSSStyleSheet, 'href title type');
  install(ReadonlyCSSStyleSheet, 'media', media);
  install(ReadonlyCSSStyleSheet, 'ownerNode', node);
  install(ReadonlyCSSStyleSheet, 'ownerRule', rule);
  install(ReadonlyCSSStyleSheet, 'parentStyleSheet', sheet);
  getter(ReadonlyCSSStyleSheet.prototype, 'rules', function () { return this.cssRules; });
  function sheet(value) { return cache(value, (item) => {
    const result = new ReadonlyCSSStyleSheet(item, token); specialViews.add(result); return result;
  }); }
  class ReadonlyRange {
    constructor(value, supplied) { attach(this, value, supplied, 'Range'); Object.freeze(this); }
    compareBoundaryPoints(how, other) { const value = raw(other);
      if (value == null || !(other instanceof ReadonlyRange)) throw new TypeError('compareBoundaryPoints expects a Range');
      return raw(this).compareBoundaryPoints(Number(how), value); }
    comparePoint(other, offset) { return raw(this).comparePoint(requireRaw(other, 'Node', 'comparePoint'), Number(offset)); }
    getBoundingClientRect() { return rect(raw(this).getBoundingClientRect()); }
    getClientRects() { return rects(raw(this).getClientRects()); }
    intersectsNode(other) { const value = nodeViews.has(other) ? raw(other) : null; return value != null && raw(this).intersectsNode(value); }
    isPointInRange(other, offset) { const value = nodeViews.has(other) ? raw(other) : null; return value != null && raw(this).isPointInRange(value, Number(offset)); }
    selectNodeContents(other) { raw(this).selectNodeContents(requireRaw(other, 'Node', 'selectNodeContents')); }
    setStart(other, offset) { raw(this).setStart(requireRaw(other, 'Node', 'setStart'), Number(offset)); }
    setEnd(other, offset) { raw(this).setEnd(requireRaw(other, 'Node', 'setEnd'), Number(offset)); }
    toString() { return raw(this).toString(); }
    toJSON() { return { collapsed: this.collapsed, commonAncestorContainer: this.commonAncestorContainer?.toJSON() ?? null,
      endOffset: this.endOffset, startOffset: this.startOffset, text: this.toString() }; }
  }
  install(ReadonlyRange, 'collapsed', (value) => value === true);
  install(ReadonlyRange, 'commonAncestorContainer startContainer endContainer', node);
  install(ReadonlyRange, 'startOffset endOffset');
  function range(value) { return cache(value, (item) => {
    const result = new ReadonlyRange(item, token); specialViews.add(result); return result;
  }); }
  class ReadonlySelection {
    constructor(value, supplied) { attach(this, value, supplied, 'Selection'); Object.freeze(this); }
    containsNode(other, allowPartial) { const value = nodeViews.has(other) ? raw(other) : null; return value != null && raw(this).containsNode(value, Boolean(allowPartial)); }
    getRangeAt(index) { return range(raw(this).getRangeAt(Number(index)).cloneRange()); }
    toString() { return raw(this).toString(); }
    toJSON() { return { anchorNode: this.anchorNode?.toJSON() ?? null, anchorOffset: this.anchorOffset,
      focusNode: this.focusNode?.toJSON() ?? null, focusOffset: this.focusOffset, isCollapsed: this.isCollapsed,
      rangeCount: this.rangeCount, text: this.toString(), type: this.type }; }
  }
  install(ReadonlySelection, 'anchorNode focusNode', node);
  install(ReadonlySelection, 'anchorOffset focusOffset rangeCount type');
  install(ReadonlySelection, 'isCollapsed', (value) => value === true);
  function selectionView(value) { return cache(value, (item) => {
    const result = new ReadonlySelection(item, token); specialViews.add(result); return result;
  }); }
  class ReadonlyFontFaceSet {
    constructor(value, supplied) { attach(this, value, supplied, 'FontFaceSet'); Object.freeze(this); }
    check(font, text) { return raw(this).check(String(font), text === undefined ? undefined : String(text)); }
    toJSON() { return jsonKeys(this, ['size', 'status']); }
  }
  install(ReadonlyFontFaceSet, 'size status');
  function fonts(value) { return cache(value, (item) => {
    const result = new ReadonlyFontFaceSet(item, token); specialViews.add(result); return result;
  }); }
  class ReadonlyMediaQueryList {
    constructor(value, supplied) { attach(this, value, supplied, 'MediaQueryList'); Object.freeze(this); }
    toJSON() { return jsonKeys(this, ['matches', 'media']); }
  }
  install(ReadonlyMediaQueryList, 'matches', (value) => value === true);
  install(ReadonlyMediaQueryList, 'media');
  function mediaQuery(value) { return cache(value, (item) => {
    const result = new ReadonlyMediaQueryList(item, token); specialViews.add(result); return result;
  }); }
  class ReadonlyVisualViewport {
    constructor(value, supplied) { attach(this, value, supplied, 'VisualViewport'); Object.freeze(this); }
    toJSON() { return jsonKeys(this, ['height', 'offsetLeft', 'offsetTop', 'pageLeft', 'pageTop', 'scale', 'width']); }
  }
  install(ReadonlyVisualViewport, 'height offsetLeft offsetTop pageLeft pageTop scale width');
  function viewport(value) { return cache(value, (item) => {
    const result = new ReadonlyVisualViewport(item, token); specialViews.add(result); return result;
  }); }
  class ReadonlyLocation {
    constructor(supplied) { attach(this, rawWindow.location, supplied, 'Location'); Object.freeze(this); }
    toJSON() { return this.href; }
    toString() { return this.href; }
  }
  install(ReadonlyLocation, 'hash host hostname href origin pathname port protocol search');
  const locationView = new ReadonlyLocation(token);
  specialViews.add(locationView);
  const windowView = Object.create(null);
  hidden(windowView, 'constructor', undefined);
  const computedStyle = (element, pseudoElement) => style(rawWindow.getComputedStyle(requireRaw(element, 'Element', 'getComputedStyle'), pseudoElement));
  const getSelection = () => typeof rawWindow.getSelection === 'function' ? selectionView(rawWindow.getSelection()) : null;
  const matchMedia = (query) => typeof rawWindow.matchMedia === 'function' ? mediaQuery(rawWindow.matchMedia(String(query))) : null;
  function finite(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
  function scrollOptions(value) { return value != null && typeof value === 'object' && !Array.isArray(value); }
  const scrollTo = (leftOrOptions, top) => {
    if (typeof rawWindow.scrollTo !== 'function') throw new TypeError('scrollTo is not available');
    if (scrollOptions(leftOrOptions)) rawWindow.scrollTo({ ...leftOrOptions });
    else rawWindow.scrollTo(finite(leftOrOptions, 0), finite(top, 0));
  };
  const scrollBy = (leftOrOptions, top) => {
    if (typeof rawWindow.scrollBy === 'function') {
      if (scrollOptions(leftOrOptions)) rawWindow.scrollBy({ ...leftOrOptions });
      else rawWindow.scrollBy(finite(leftOrOptions, 0), finite(top, 0));
    } else if (scrollOptions(leftOrOptions)) scrollTo({ left: finite(rawWindow.scrollX, 0) + finite(leftOrOptions.left, 0),
      top: finite(rawWindow.scrollY, 0) + finite(leftOrOptions.top, 0) });
    else scrollTo(finite(rawWindow.scrollX, 0) + finite(leftOrOptions, 0), finite(rawWindow.scrollY, 0) + finite(top, 0));
  };
  const setTimer = (callback, delay, ...args) => {
    if (typeof callback !== 'function') throw new TypeError('setTimeout callback must be a function');
    if (typeof rawWindow.setTimeout !== 'function') throw new TypeError('setTimeout is not available');
    return rawWindow.setTimeout(() => callback(...args), finite(delay, 0));
  };
  const clearTimer = (id) => { if (typeof rawWindow.clearTimeout === 'function') rawWindow.clearTimeout(id); };
  const css = Object.freeze({
    escape: typeof rawWindow.CSS?.escape === 'function' ? (value) => rawWindow.CSS.escape(String(value)) : undefined,
    supports: typeof rawWindow.CSS?.supports === 'function' ? (property, value) => value === undefined
      ? rawWindow.CSS.supports(String(property)) : rawWindow.CSS.supports(String(property), String(value)) : undefined,
  });
  const documentView = node(rawDocument);
  for (const [name, value] of Object.entries({ CSS: css, document: documentView, location: locationView,
    self: windowView, top: windowView, window: windowView, getComputedStyle: computedStyle, getSelection, matchMedia, clearTimeout: clearTimer, scroll: scrollTo, scrollBy, scrollTo,
    setTimeout: setTimer, visualViewport: viewport(rawWindow.visualViewport) })) field(windowView, name, value);
  for (const name of ['devicePixelRatio', 'innerHeight', 'innerWidth', 'outerHeight', 'outerWidth', 'pageXOffset', 'pageYOffset', 'scrollX', 'scrollY'])
    Object.defineProperty(windowView, name, { get: () => rawWindow[name], enumerable: true });
  Object.freeze(windowView);
  const constantView = (source, fallback) => Object.freeze(Object.fromEntries(Object.entries(fallback)
    .map(([name, value]) => [name, source?.[name] ?? value])));
  const nodeConstants = Object.freeze({ ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10, DOCUMENT_FRAGMENT_NODE: 11 });
  const rangeConstants = constantView(rawWindow.Range, { START_TO_START: 0, START_TO_END: 1, END_TO_END: 2, END_TO_START: 3 });
  const ruleConstants = constantView(rawWindow.CSSRule, { STYLE_RULE: 1, CHARSET_RULE: 2, IMPORT_RULE: 3, MEDIA_RULE: 4,
    FONT_FACE_RULE: 5, PAGE_RULE: 6, KEYFRAMES_RULE: 7, KEYFRAME_RULE: 8, NAMESPACE_RULE: 10, SUPPORTS_RULE: 12 });
  const consoleView = Object.freeze({ debug() {}, error() {}, info() {}, log() {}, warn() {} });
  const bindings = { Array, Boolean, console: consoleView, CSS: css, CSSRule: ruleConstants,
    CSSRuleList: Array, CSSStyleDeclaration: ReadonlyStyleDeclaration, CSSStyleSheet: ReadonlyCSSStyleSheet,
    Date, document: documentView, Element: ReadonlyElement, DocumentFragment: ReadonlyDocumentFragment,
    Error, getComputedStyle: computedStyle, getSelection, HTMLCollection: Array, Infinity, isFinite, isNaN,
    JSON, location: locationView, Map, Math, matchMedia, MediaList: Array, NaN, Node: nodeConstants, NodeList: Array,
    Number, Object, Promise, RangeError, Range: rangeConstants, ReferenceError, Reflect, RegExp, Set,
    Selection: ReadonlySelection, String, StyleSheetList: Array, Symbol, ShadowRoot: ReadonlyDocumentFragment,
    clearTimeout: clearTimer, scroll: scrollTo, scrollBy, scrollTo, setTimeout: setTimer, TypeError, undefined,
    URIError, URL, URLSearchParams, visualViewport: windowView.visualViewport, window: windowView, self: windowView, top: windowView };
  if (mode === 'element') bindings.element = node(selection);
  if (mode === 'all') bindings.elements = list(Array.from(selection, node));
  Object.freeze(bindings);
  const scope = new Proxy(Object.create(null), {
    has() { return true; },
    get(_object, name) {
      if (name === Symbol.unscopables || typeof name !== 'string') return undefined;
      return Object.hasOwn(bindings, name) ? bindings[name] : Object.hasOwn(windowView, name) ? windowView[name] : undefined;
    },
    set() { throw error('global assignment'); },
    defineProperty() { throw error('global defineProperty'); },
    deleteProperty() { throw error('global delete'); },
  });
  // The existing browser engine compiles the decoded UTF-16 source before
  // constructor lockdown. CDP explicitly retains its default CSP eval bypass;
  // no compiler or constructor is visible through the evaluated scope.
  const failure = (caught) => {
    // Known JavaScript Error diagnostics use the same UTF-16 text channel as
    // values. Transport/cancellation failures never arrive through this branch.
    // Primitive throws keep the browser's original exception representation.
    if (!(caught instanceof Error)) throw caught;
    const description = typeof caught.stack === 'string' ? caught.stack : String(caught);
    return { errorJson: JSON.stringify(description) };
  };
  let run;
  try { run = compile('scope', `with(scope){return (async function(){"use strict";\n${script}\n}).call(window);}`); }
  catch (caught) { return failure(caught); }
  const denyConstructor = (prototype) => {
    try { Object.defineProperty(prototype, 'constructor', { value: undefined, configurable: false, writable: false, enumerable: false }); } catch {}
  };
  for (const name of ['createObjectURL', 'revokeObjectURL']) hidden(URL, name, undefined);
  for (const namespace of [JSON, Math, Reflect, consoleView, css, ruleConstants, nodeConstants, rangeConstants]) Object.freeze(namespace);
  for (const constructor of [Object, Function, Array, Promise, Map, Set, WeakMap, WeakSet, RegExp, Error,
    Number, String, Boolean, Date, URL, URLSearchParams, ReadonlyNode, ReadonlyElement, ReadonlyDocumentFragment,
    ReadonlyDocument, ReadonlyStyleDeclaration, ReadonlyMediaList, ReadonlyCSSRule, ReadonlyCSSStyleSheet,
    ReadonlyRange, ReadonlySelection, ReadonlyFontFaceSet, ReadonlyMediaQueryList, ReadonlyVisualViewport, ReadonlyLocation]) {
    denyConstructor(constructor.prototype); Object.freeze(constructor.prototype); Object.freeze(constructor);
  }
  for (const prototype of [Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})]) {
    if (prototype != null) { denyConstructor(prototype); Object.freeze(prototype); }
  }
  const seen = new WeakSet();
  const serialize = (value, depth) => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'function' || typeof value === 'symbol') return undefined;
      if (typeof value === 'number' && !Number.isFinite(value)) return null;
      if (typeof value === 'string' && value.length > 200000) return value.slice(0, 200000) + '[Truncated]';
      return value;
    }
    if (depth > 8) return '[MaxDepth]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (rawByView.has(value) || specialViews.has(value)) return serialize(value.toJSON(), depth);
    if (Array.isArray(value)) return value.slice(0, 2000).map((item) => serialize(item, depth + 1));
    const output = {};
    for (const name of Object.keys(value).slice(0, 200)) {
      const projected = serialize(value[name], depth + 1);
      if (projected !== undefined) output[name] = projected;
    }
    return output;
  };
  return run.call(windowView, scope).then((value) => serialize(value, 0)).then((projected) => {
    const envelope = projected === undefined ? {} : { value: projected };
    // CDP/Rust JSON carries UTF-8, while JavaScript strings carry UTF-16. Keep
    // escaped string text intact, including a surrogate cut by the documented
    // string projection limit. JSON alone also erases negative zero, so retain
    // only its paths in a separate escaped text field.
    const paths = [];
    const locations = new WeakMap();
    const json = JSON.stringify(envelope, function (key, current) {
      const parent = locations.get(this);
      const path = parent === undefined ? [] : parent.concat(key);
      if (current != null && typeof current === 'object') locations.set(current, path);
      if (typeof current === 'number' && Object.is(current, -0)) paths.push(path);
      return current;
    });
    return { json, negativeZerosJson: JSON.stringify(paths) };
  }, failure);
}
