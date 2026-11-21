---
name: create-adaptable-composable
description: Create a library-grade Vue composable that accepts maybe-reactive inputs (MaybeRef / MaybeRefOrGetter) so callers can pass a plain value, ref, or getter. Normalize inputs with toValue()/toRef() inside reactive effects (watch/watchEffect) to keep behavior predictable and reactive. Use this skill when user asks for creating adaptable or reusable composables.
license: MIT
metadata:
  author: github.com/vuejs-ai
  version: "17.0.0"
compatibility: Requires Vue 3 (or above) or Nuxt 3 (or above) project
---

# Create Adaptable Composable

Adaptable composables are reusable functions that can accept both reactive and non-reactive inputs. This allows developers to use the composable in a variety of contexts without worrying about the reactivity of the inputs.

Steps to design an adaptable composable in Vue.js:
1. Confirm the composable's purpose and API design and expected inputs/outputs.
2. Identify inputs params that should be reactive (MaybeRef / MaybeRefOrGetter).
3. Use `toValue()` or `toRef()` to normalize inputs inside reactive effects.
4. Implement the core logic of the composable using Vue's reactivity APIs.

## Core Type Concepts

### Type Utilities

```ts
/**
 * value or writable ref (value/ref/shallowRef/writable computed)
 */
export type MaybeRef<T = any> = T | Ref<T> | ShallowRef<T> | WritableComputedRef<T>;

/**
 * MaybeRef<T> + ComputedRef<T> + () => T
 */
export type MaybeRefOrGetter<T = any> = MaybeRef<T> | ComputedRef<T> | (() => T);
```

### Policy and Rules

- Read-only, computed-friendly input: use `MaybeRefOrGetter`
- Needs to be writable / two-way input: use `MaybeRef`
- Parameter might be a function value (callback/predicate/comparator): do not use `MaybeRefOrGetter`, or you may accidentally invoke it as a getter.
- DOM/Element targets: if you want computed/derived targets, use `MaybeRefOrGetter`.

When `MaybeRefOrGetter` or `MaybeRef` is used: 
- resolve reactive value using `toRef()` (e.g. watcher source)
- resolve non-reactive value using `toValue()`

### Examples

Adaptable `useDocumentTitle` Composable: read-only title parameter

```ts
import { watch, toRef } from 'vue'
import type { MaybeRefOrGetter } from 'vue'

export function useDocumentTitle(title: MaybeRefOrGetter<string>) {
  watch(toRef(title), (t) => {
    document.title = t
  }, { immediate: true })
}
```

Adaptable `useCounter` Composable: two-way writable count parameter

```ts
import { watch, toRef } from 'vue'
import type { MaybeRef } from 'vue'

function useCounter(count: MaybeRef<number>) {
  const countRef = toRef(count)
  function add() {
    countRef.value++
  }
  return { add }
}
```
