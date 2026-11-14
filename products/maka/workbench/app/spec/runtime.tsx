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

import {
  createDirectiveRegistry,
  evaluateVisibility,
  getByPath,
  resolveAction,
  resolveActionParam,
  resolveBindings,
  resolveElementProps,
  resolveRepeatItemStatePath,
  resolveRepeatStatePath,
  runValidation,
  splitRepeatVisibility,
  type ActionBinding,
  type ComputedFunction,
  type PropResolutionContext,
  type ResolvedAction,
  type Spec,
  type StateModel,
  type UIElement,
  type ValidationCheck,
  type ValidationConfig,
} from '@json-render/core';
import { standardDirectives } from '@json-render/directives';
import {
  Clipboard,
  cleanup,
  computed,
  context,
  effect,
  ErrorBoundary,
  signal,
  Text,
  untracked,
  View,
  type JSX,
} from 'nsh';
import { Button } from 'nsh/base';
import { tr } from '../locale';
import { DialogFooter, DialogHeader, ModalDialog } from '../ModalDialog';
import { C, captionTextStyle, controlFocusStyle, controlHoverStyle, controlStyle } from '../ui';
import type { SpecSession } from './session.ts';

export type SpecElementRenderContext = {
  element: () => UIElement;
  props: () => Record<string, unknown>;
  bindings: () => Record<string, string> | undefined;
  emit: (event: string) => void;
  children: () => JSX.Element;
  renderSlot: (name: string) => JSX.Element;
  hasSlot: (name: string) => boolean;
};

export type SpecComponentRenderer = (ctx: SpecElementRenderContext) => JSX.Element;
export type SpecComponentRegistry = Readonly<Record<string, SpecComponentRenderer>>;

export type RepeatScopeValue = {
  item: unknown;
  index: number;
  basePath: string;
};

const MAX_WATCH_CASCADE = 16;

const directiveRegistry = createDirectiveRegistry(standardDirectives);

function toNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const n = typeof item === 'number' ? item : Number(item);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const builtInFunctions: Record<string, ComputedFunction> = {
  sum: ({ values, field }) => {
    if (Array.isArray(values) && typeof field === 'string') {
      return values.reduce((acc: number, row) => {
        const v =
          row && typeof row === 'object' ? Number((row as Record<string, unknown>)[field]) : 0;
        return acc + (Number.isFinite(v) ? v : 0);
      }, 0);
    }
    return toNumbers(values).reduce((a, b) => a + b, 0);
  },
  avg: ({ values }) => {
    const nums = toNumbers(values);
    return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
  },
  min: ({ values }) => {
    const nums = toNumbers(values);
    return nums.length === 0 ? 0 : Math.min(...nums);
  },
  max: ({ values }) => {
    const nums = toNumbers(values);
    return nums.length === 0 ? 0 : Math.max(...nums);
  },
  count: ({ values }) => (Array.isArray(values) ? values.length : 0),
  join: ({ values, separator }) =>
    Array.isArray(values)
      ? values.map((v) => String(v ?? '')).join(typeof separator === 'string' ? separator : ', ')
      : '',
  round: ({ value, digits }) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const d = typeof digits === 'number' && digits >= 0 ? Math.min(10, Math.floor(digits)) : 0;
    const factor = 10 ** d;
    return Math.round(n * factor) / factor;
  },
  clamp: ({ value, min, max }) => {
    const n = Number(value);
    const lo = typeof min === 'number' ? min : Number.NEGATIVE_INFINITY;
    const hi = typeof max === 'number' ? max : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(n)) return Number.isFinite(lo) ? lo : 0;
    return Math.min(hi, Math.max(lo, n));
  },
  coalesce: ({ a, b, c }) => a ?? b ?? c ?? '',
  upper: ({ value }) => String(value ?? '').toUpperCase(),
  lower: ({ value }) => String(value ?? '').toLowerCase(),
};

let nextAutoId = 0;
function makeAutoId(): string {
  nextAutoId += 1;
  return `item-${Date.now()}-${nextAutoId}`;
}

function deepResolvePushValue(value: unknown, get: (path: string) => unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value === '$id') return makeAutoId();
  if (Array.isArray(value)) return value.map((item) => deepResolvePushValue(item, get));
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj.$state === 'string') {
      return get(obj.$state);
    }
    if (keys.length === 1 && '$id' in obj) {
      return makeAutoId();
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = deepResolvePushValue(v, get);
    }
    return out;
  }
  return value;
}

type FieldRegistration = {
  config: () => ValidationConfig;
};

type PendingConfirm = {
  resolved: ResolvedAction;
  run: () => Promise<void>;
};

export type SpecRuntime = {
  session: SpecSession;
  sessionId?: string;
  state: () => StateModel;
  get: (path: string) => unknown;
  set: (path: string, value: unknown) => void;
  update: (updates: Record<string, unknown>) => void;
  openLink?: (target: string, restoreFocus: () => boolean) => Promise<void>;
  registerField: (path: string, config: () => ValidationConfig) => void;
  unregisterField: (path: string) => void;
  validateField: (path: string, configOverride?: ValidationConfig) => string[];
  fieldErrors: (path: string | undefined) => string[];
  validateAll: () => { valid: boolean; errors: Record<string, string[]> };
  executeActionBinding: (binding: ActionBinding, propCtx: PropResolutionContext) => Promise<void>;
  runWatchBindings: (bindings: readonly unknown[], propCtx: PropResolutionContext) => void;
};

const SpecRuntimeCtx = context<SpecRuntime | null>(null);
const RepeatScopeCtx = context<(() => RepeatScopeValue) | null>(null);

export function useSpecRuntime(): SpecRuntime {
  const ctx = SpecRuntimeCtx();
  if (!ctx) throw new Error('useSpecRuntime must be called inside SpecRenderer');
  return ctx;
}

export function useRepeatScope(): (() => RepeatScopeValue) | null {
  return RepeatScopeCtx();
}

export function useBoundField(
  bindings: () => Record<string, string> | undefined,
  bindingKey: string,
  checksProp: () => unknown,
  validateOnProp?: () => unknown,
) {
  const runtime = useSpecRuntime();
  let registeredPath: string | undefined;

  const parseConfig = (): ValidationConfig => {
    const rawChecks = checksProp();
    const checks: ValidationCheck[] = Array.isArray(rawChecks)
      ? rawChecks.filter(
          (item): item is ValidationCheck =>
            Boolean(item) &&
            typeof item === 'object' &&
            typeof (item as ValidationCheck).type === 'string' &&
            typeof (item as ValidationCheck).message === 'string',
        )
      : [];
    const rawMode = validateOnProp?.();
    const validateOn =
      rawMode === 'change' || rawMode === 'blur' || rawMode === 'submit' ? rawMode : 'blur';
    return { checks, validateOn };
  };

  effect(() => {
    const path = bindings()?.[bindingKey];
    const hasChecks = (parseConfig().checks?.length ?? 0) > 0;
    if (registeredPath && registeredPath !== path) {
      runtime.unregisterField(registeredPath);
      registeredPath = undefined;
    }
    if (path && hasChecks) {
      registeredPath = path;
      runtime.registerField(path, parseConfig);
    }
  });

  cleanup(() => {
    if (registeredPath) {
      runtime.unregisterField(registeredPath);
      registeredPath = undefined;
    }
  });

  const path = () => bindings()?.[bindingKey];
  const errors = () => runtime.fieldErrors(path());
  const write = (value: unknown) => {
    const currentPath = path();
    if (!currentPath) return;
    runtime.set(currentPath, value);
    const cfg = parseConfig();
    if ((cfg.checks?.length ?? 0) > 0 && cfg.validateOn === 'change') {
      runtime.validateField(currentPath, cfg);
    }
  };
  const blur = () => {
    const currentPath = path();
    if (!currentPath) return;
    const cfg = parseConfig();
    if ((cfg.checks?.length ?? 0) > 0 && (cfg.validateOn ?? 'blur') === 'blur') {
      runtime.validateField(currentPath, cfg);
    }
  };

  return { path, errors, write, blur };
}

function resolveBindingParams(
  binding: ActionBinding,
  propCtx: PropResolutionContext,
): ActionBinding {
  if (!binding.params) return binding;
  const resolved: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(binding.params)) {
    resolved[key] = resolveActionParam(val, propCtx);
  }
  return { ...binding, params: resolved };
}

export function SpecRenderer(props: {
  spec: () => Spec;
  session: SpecSession;
  registry: SpecComponentRegistry;
  sessionId?: string;
  openLink?: (target: string, restoreFocus: () => boolean) => Promise<void>;
}) {
  let inWatchAction = 0;
  let watchCascadeCount = 0;

  const state = signal<StateModel>(props.session.store.getSnapshot());
  const unsubscribe = props.session.store.subscribe(() => {
    if (inWatchAction === 0) {
      watchCascadeCount = 0;
    }
    state.set(props.session.store.getSnapshot());
  });
  cleanup(unsubscribe);

  const fields = new Map<string, FieldRegistration>();
  const errorsByPath = signal<Record<string, string[]>>({});
  const pendingConfirm = signal<PendingConfirm | null>(null);

  const validateField = (path: string, configOverride?: ValidationConfig): string[] => {
    const cfg = configOverride ?? fields.get(path)?.config();
    if (!cfg || !cfg.checks || cfg.checks.length === 0) return [];
    const snapshot = props.session.store.getSnapshot();
    const result = runValidation(cfg, {
      value: getByPath(snapshot, path),
      stateModel: snapshot,
    });
    const current = errorsByPath();
    if (result.errors.length === 0) {
      if (path in current) {
        const next = { ...current };
        delete next[path];
        errorsByPath.set(next);
      }
    } else {
      errorsByPath.set({ ...current, [path]: result.errors });
    }
    return result.errors;
  };

  const validateAll = () => {
    let valid = true;
    const nextErrors: Record<string, string[]> = {};
    const snapshot = props.session.store.getSnapshot();
    for (const [path, reg] of fields.entries()) {
      const cfg = reg.config();
      if (!cfg.checks || cfg.checks.length === 0) continue;
      const result = runValidation(cfg, {
        value: getByPath(snapshot, path),
        stateModel: snapshot,
      });
      if (!result.valid) {
        valid = false;
        nextErrors[path] = result.errors;
      }
    }
    errorsByPath.set(nextErrors);
    return { valid, errors: nextErrors };
  };

  const runResolvedAction = async (resolved: ResolvedAction): Promise<void> => {
    const params = resolved.params ?? {};
    switch (resolved.action) {
      case 'setState': {
        const statePath = typeof params.statePath === 'string' ? params.statePath : '';
        if (statePath) props.session.userSet(statePath, params.value);
        break;
      }
      case 'pushState': {
        const statePath = typeof params.statePath === 'string' ? params.statePath : '';
        if (statePath) {
          const item = deepResolvePushValue(params.value, (p) => props.session.store.get(p));
          const existing = props.session.store.get(statePath);
          const list = Array.isArray(existing) ? existing : [];
          props.session.userSet(statePath, [...list, item]);
          if (typeof params.clearStatePath === 'string' && params.clearStatePath) {
            props.session.userSet(params.clearStatePath, '');
          }
        }
        break;
      }
      case 'removeState': {
        const statePath = typeof params.statePath === 'string' ? params.statePath : '';
        const index = typeof params.index === 'number' ? params.index : Number(params.index);
        if (statePath && Number.isInteger(index) && index >= 0) {
          const existing = props.session.store.get(statePath);
          const list = Array.isArray(existing) ? existing : [];
          props.session.userSet(
            statePath,
            list.filter((_, idx) => idx !== index),
          );
        }
        break;
      }
      case 'toggleState': {
        const statePath = typeof params.statePath === 'string' ? params.statePath : '';
        if (statePath) {
          const current = Boolean(props.session.store.get(statePath));
          props.session.userSet(statePath, !current);
        }
        break;
      }
      case 'resetState': {
        const statePath = typeof params.statePath === 'string' ? params.statePath : undefined;
        props.session.resetState(statePath);
        errorsByPath.set({});
        break;
      }
      case 'validateForm': {
        const target =
          typeof params.statePath === 'string' && params.statePath
            ? params.statePath
            : '/formValidation';
        const outcome = validateAll();
        props.session.userSet(target, outcome);
        break;
      }
      case 'copyText': {
        if (params.text !== undefined && params.text !== null) {
          await Clipboard.writeText(String(params.text));
        }
        break;
      }
      default:
        // Strict client-only boundary: unknown or server/agent actions are ignored.
        return;
    }

    if (resolved.onSuccess && 'set' in resolved.onSuccess && resolved.onSuccess.set) {
      const updates: Record<string, unknown> = {};
      const snapshot = props.session.store.getSnapshot();
      for (const [path, val] of Object.entries(resolved.onSuccess.set)) {
        updates[path] = deepResolvePushValue(val, (p) => getByPath(snapshot, p));
      }
      props.session.userUpdate(updates);
    }
  };

  const executeActionBinding = async (
    rawBinding: ActionBinding,
    propCtx: PropResolutionContext,
  ): Promise<void> => {
    if (rawBinding.preventDefault) {
      // No browser default in native NSH; honored as no-op marker.
    }
    const scoped = resolveBindingParams(rawBinding, propCtx);
    const resolved = resolveAction(scoped, props.session.store.getSnapshot());
    const perform = async () => {
      try {
        await runResolvedAction(resolved);
      } catch (err) {
        if (resolved.onError && 'set' in resolved.onError && resolved.onError.set) {
          const updates: Record<string, unknown> = {};
          const message = err instanceof Error ? err.message : String(err);
          for (const [path, val] of Object.entries(resolved.onError.set)) {
            updates[path] = val === '$error.message' ? message : val;
          }
          props.session.userUpdate(updates);
        }
      }
    };

    if (resolved.confirm) {
      pendingConfirm.set({ resolved, run: perform });
      return;
    }
    await perform();
  };

  const runWatchBindings = (
    bindingsList: readonly unknown[],
    currentPropCtx: PropResolutionContext,
  ): void => {
    if (watchCascadeCount >= MAX_WATCH_CASCADE) return;
    watchCascadeCount += 1;
    inWatchAction += 1;
    const tasks: Promise<void>[] = [];
    try {
      for (const b of bindingsList) {
        if (b && typeof b === 'object' && 'action' in b) {
          tasks.push(executeActionBinding(b as ActionBinding, currentPropCtx));
        }
      }
    } finally {
      if (tasks.length === 0) {
        inWatchAction -= 1;
      } else {
        void Promise.allSettled(tasks).then(() => {
          inWatchAction -= 1;
        });
      }
    }
  };

  const runtime: SpecRuntime = {
    session: props.session,
    sessionId: props.sessionId,
    state,
    get: (path) => getByPath(state(), path),
    set: (path, value) => {
      if (inWatchAction === 0) watchCascadeCount = 0;
      props.session.userSet(path, value);
    },
    update: (updates) => {
      if (inWatchAction === 0) watchCascadeCount = 0;
      props.session.userUpdate(updates);
    },
    openLink: props.openLink,
    registerField: (path, config) => {
      fields.set(path, { config });
    },
    unregisterField: (path) => {
      fields.delete(path);
    },
    validateField,
    fieldErrors: (path) => (path ? (errorsByPath()[path] ?? []) : []),
    validateAll,
    executeActionBinding: async (binding, propCtx) => {
      if (inWatchAction === 0) watchCascadeCount = 0;
      await executeActionBinding(binding, propCtx);
    },
    runWatchBindings,
  };

  return (
    <SpecRuntimeCtx.Provider value={runtime}>
      <View style={{ width: '100%', minWidth: 0 }}>
        <ElementByKey
          elementKey={() => props.spec().root}
          spec={props.spec}
          registry={props.registry}
          ancestors={new Set()}
        />
        <If when={pendingConfirm()}>
          <ModalDialog size="alert" onCancel={() => pendingConfirm.set(null)}>
            <DialogHeader
              title={pendingConfirm()!.resolved.confirm!.title}
              detail={pendingConfirm()!.resolved.confirm!.message}
            />
            <DialogFooter>
              <Button
                accessibilityLabel={pendingConfirm()!.resolved.confirm!.cancelLabel ?? tr('Cancel')}
                onPress={() => pendingConfirm.set(null)}
                style={{ ...controlStyle, borderWidth: 1, borderColor: C.line }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
              >
                <Text style={{ ...captionTextStyle, color: C.text }}>
                  {pendingConfirm()!.resolved.confirm!.cancelLabel ?? tr('Cancel')}
                </Text>
              </Button>
              <Button
                accessibilityLabel={
                  pendingConfirm()!.resolved.confirm!.confirmLabel ?? tr('Confirm')
                }
                onPress={() => {
                  const current = pendingConfirm();
                  pendingConfirm.set(null);
                  if (current) void current.run();
                }}
                style={{
                  ...controlStyle,
                  backgroundColor:
                    pendingConfirm()!.resolved.confirm!.variant === 'danger' ? C.danger : C.accent,
                }}
                hoverStyle={{ opacity: 0.9 }}
                focusStyle={controlFocusStyle()}
              >
                <Text style={{ ...captionTextStyle, color: C.background, fontWeight: '600' }}>
                  {pendingConfirm()!.resolved.confirm!.confirmLabel ?? tr('Confirm')}
                </Text>
              </Button>
            </DialogFooter>
          </ModalDialog>
        </If>
      </View>
    </SpecRuntimeCtx.Provider>
  );
}

function ElementByKey(props: {
  elementKey: () => string;
  spec: () => Spec;
  registry: SpecComponentRegistry;
  ancestors: ReadonlySet<string>;
}) {
  const key = () => props.elementKey();
  const element = () => {
    const k = key();
    if (!k || props.ancestors.has(k)) return undefined;
    return props.spec().elements[k];
  };
  const hasElement = computed(() => Boolean(element()));
  const elementType = computed(() => element()?.type ?? '');

  return (
    <If when={hasElement()}>
      <Each of={[elementType()]} key={(t) => `${key()}:${t}`}>
        {() => (
          <ErrorBoundary
            fallback={(error) => (
              <Text style={{ ...captionTextStyle, color: C.danger }}>
                {tr('Interface unavailable: {reason}', {
                  reason: error instanceof Error ? error.message : String(error),
                })}
              </Text>
            )}
          >
            <ElementInstance
              elementKey={key()}
              element={() => props.spec().elements[key()]!}
              spec={props.spec}
              registry={props.registry}
              ancestors={new Set([...props.ancestors, key()])}
            />
          </ErrorBoundary>
        )}
      </Each>
    </If>
  );
}

function ElementInstance(props: {
  elementKey: string;
  element: () => UIElement;
  spec: () => Spec;
  registry: SpecComponentRegistry;
  ancestors: ReadonlySet<string>;
}) {
  const runtime = useSpecRuntime();
  const scope = useRepeatScope();

  const visCtx = () => {
    const s = scope?.();
    return {
      stateModel: runtime.state(),
      ...(s ? { repeatItem: s.item, repeatIndex: s.index } : {}),
    };
  };

  const propCtx = (): PropResolutionContext => {
    const s = scope?.();
    return {
      ...visCtx(),
      repeatBasePath: s?.basePath,
      directives: directiveRegistry,
      functions: builtInFunctions,
    };
  };

  const isVisible = () => {
    const el = props.element();
    if (!el) return false;
    if (el.repeat) {
      const { container } = splitRepeatVisibility(el.visible);
      return evaluateVisibility(container, visCtx());
    }
    return evaluateVisibility(el.visible, visCtx());
  };

  const prevWatched = new Map<string, unknown>();
  effect(() => {
    const watchMap = props.element()?.watch;
    if (!watchMap || typeof watchMap !== 'object') {
      prevWatched.clear();
      return;
    }
    const snapshot = runtime.state();
    for (const [watchPath, bindingOrList] of Object.entries(watchMap)) {
      const nextValue = getByPath(snapshot, watchPath);
      if (!prevWatched.has(watchPath)) {
        prevWatched.set(watchPath, nextValue);
        continue;
      }
      const prevValue = prevWatched.get(watchPath);
      if (!Object.is(nextValue, prevValue)) {
        prevWatched.set(watchPath, nextValue);
        const bindingsList = Array.isArray(bindingOrList) ? bindingOrList : [bindingOrList];
        untracked(() => {
          runtime.runWatchBindings(bindingsList, propCtx());
        });
      }
    }
  });

  const Component = props.registry[props.element()?.type ?? ''];
  if (!Component) return <View />;

  const rawProps = () => (props.element()?.props ?? {}) as Record<string, unknown>;
  const bindings = computed(() => resolveBindings(rawProps(), propCtx()));
  const resolvedProps = computed(() => resolveElementProps(rawProps(), propCtx()));

  const emit = (eventName: string) => {
    const onMap = props.element()?.on;
    if (!onMap || typeof onMap !== 'object') return;
    const raw = (onMap as Record<string, ActionBinding | ActionBinding[] | undefined>)[eventName];
    if (!raw) return;
    const list = Array.isArray(raw) ? raw : [raw];
    const currentPropCtx = propCtx();
    for (const binding of list) {
      if (binding && typeof binding === 'object' && 'action' in binding) {
        void runtime.executeActionBinding(binding, currentPropCtx);
      }
    }
  };

  const renderKeyList = (keys: () => readonly string[]) => (
    <Each of={keys()} key={(childKey) => childKey}>
      {(childKey) => (
        <ElementByKey
          elementKey={childKey}
          spec={props.spec}
          registry={props.registry}
          ancestors={props.ancestors}
        />
      )}
    </Each>
  );

  const renderRepeatedChildren = () => {
    const repeat = () => props.element()?.repeat;
    const entries = () => {
      const cfg = repeat();
      if (!cfg) return [];
      const arrayPath = resolveRepeatStatePath(cfg.statePath, scope?.()?.basePath);
      if (!arrayPath) return [];
      const rawItems = getByPath(runtime.state(), arrayPath);
      if (!Array.isArray(rawItems)) return [];
      const { itemFilter } = splitRepeatVisibility(props.element()?.visible);
      const seenKeys = new Map<string, number>();
      const out: Array<{ key: string; item: unknown; index: number; basePath: string }> = [];
      for (let idx = 0; idx < rawItems.length; idx++) {
        const item = rawItems[idx];
        const basePath = resolveRepeatItemStatePath(arrayPath, idx);
        if (
          itemFilter &&
          !evaluateVisibility(itemFilter, {
            stateModel: runtime.state(),
            repeatItem: item,
            repeatIndex: idx,
          })
        ) {
          continue;
        }
        let itemKey = String(idx);
        if (cfg.key && item && typeof item === 'object' && cfg.key in (item as object)) {
          const rawKey = (item as Record<string, unknown>)[cfg.key];
          if (rawKey !== null && rawKey !== undefined && rawKey !== '') {
            itemKey = String(rawKey);
          }
        }
        const dupCount = seenKeys.get(itemKey) ?? 0;
        seenKeys.set(itemKey, dupCount + 1);
        const uniqueKey = dupCount === 0 ? itemKey : `${itemKey}#${dupCount}`;
        out.push({ key: uniqueKey, item, index: idx, basePath });
      }
      return out;
    };

    return (
      <Each of={entries()} key={(entry) => entry.key}>
        {(entry) => (
          <RepeatScopeCtx.Provider value={entry}>
            {renderKeyList(() => props.element()?.children ?? [])}
          </RepeatScopeCtx.Provider>
        )}
      </Each>
    );
  };

  const hasRepeat = computed(() => Boolean(props.element()?.repeat));
  const children = () => (
    <If when={hasRepeat()} else={renderKeyList(() => props.element()?.children ?? [])}>
      {renderRepeatedChildren()}
    </If>
  );

  const renderSlot = (slotName: string) => {
    if (slotName === 'default') return children();
    return renderKeyList(() => props.element()?.slots?.[slotName] ?? []);
  };

  const hasSlot = (slotName: string): boolean => {
    const el = props.element();
    if (!el) return false;
    if (slotName === 'default') return (el.children?.length ?? 0) > 0;
    return (el.slots?.[slotName]?.length ?? 0) > 0;
  };

  return (
    <If when={isVisible()}>
      {Component({
        element: props.element,
        props: resolvedProps,
        bindings,
        emit,
        children,
        renderSlot,
        hasSlot,
      })}
    </If>
  );
}
