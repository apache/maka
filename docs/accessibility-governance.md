# Accessibility governance

[中文](./accessibility-governance.zh-CN.md)

Maka's desktop UI has two audiences that read the same accessibility tree: a
person using VoiceOver, and Maka's own Computer Use driving another window. They
want the same things, and where they differ this document says which wins.

Everything below was measured against the running app on 2026-07-29 with
`maka-cu`'s `snapshot` command. The numbers are reproducible, not illustrative.

## 0. What the tree looks like today

615 elements. The web contents are fully exposed — the tree reaches real DOM,
with roles, names, values, placeholders and states — because the driver enables
them from outside:

```swift
AXUIElementSetAttributeValue(appElement, "AXManualAccessibility", true)
AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface", true)
```

Maka does not call `app.setAccessibilitySupportEnabled` and does not need to.
Chromium withholds the tree until something asks; the driver asks.

## 1. A name identifies. It does not report state.

This is the rule that matters most, and the one the app breaks today.

A control's accessible name is how both audiences refer to it. If the name
changes when the control's own value changes, then acting on the control
invalidates the way you found it. A screen-reader user hears the value twice; a
model that observed the control cannot name it afterwards.

Measured, from the composer:

```
组合框  Description: 权限模式：跳过确认   Value: 跳过确认
                     ^^^^^^^^^^^^^^^^                  the same fact, twice
```

The source is `packages/ui/src/conversation-copy.ts`:

```ts
modeAriaLabel: (label) => `权限模式：${label}`
```

### The test

Interpolating into a name is not the defect. Ask instead:

> Is the interpolated fact already exposed by the platform on this same element,
> as `AXValue`, or as a state such as `disabled`, `selected` or `expanded`?

| the name carries | example | verdict |
|---|---|---|
| the element's own value, already in `AXValue` | `权限模式：跳过确认` | duplicated — remove it from the name |
| which object the control acts on | `移除 附件.png`, `kami-report 项目操作` | that is identity — keep it |
| state the platform does not otherwise expose | `显示 12 条更多对话` | keep it, and prefer exposing the state properly |

The third row is not a loophole. If a fact matters enough to put in the name,
it usually belongs in a value or a state where both audiences can read it
without parsing a sentence. Reach for the name last.

### Applying it

A popup or combobox names what it controls, and its current setting is its
value:

```tsx
// wrong — the name changes when the user changes the setting
<Trigger aria-label={`权限模式：${current}`}>

// right — the name is stable, the setting is the value
<Trigger aria-label="权限模式">
```

The composer's model picker is already correct and is the reference:
`Description: 切换当前会话模型`, `Value: Claude Opus 4.6`.

### Busy is not a new name

A control must not rename itself while it works. Four did:

| control | said | already said by |
|---|---|---|
| usage refresh | `刷新中…` | `disabled`, `aria-busy`, `data-pending` |
| password copy | `复制中…`, `已复制` | `disabled` |
| MCP install | `取消中…` | `disabled` |
| code-block copy | `复制中…`, `已复制`, `复制失败` | `aria-busy`, `disabled`, `data-copy-feedback` |

Progress belongs in `disabled` / `aria-busy`, which both audiences read. A
confirmation belongs in a live region — `<span className="maka-visually-hidden"
role="status" aria-live="polite">` is the established pattern. Neither belongs
in the name, because the name is the only handle anyone has on the control, and
taking it away mid-operation takes it away exactly when they are waiting.

A name that switches because the *action* switches is correct and common:
stop / reload, install / cancel, expand / collapse. The discriminator is not the
wording — `loading` appears in both — but whether the handler switches on the
same condition. Flagging by vocabulary alone gave two false positives out of
three; `check-a11y.mjs` now checks the handler.

## 2. Identity comes from class names, not from generated ids

There is no stable per-element identifier in this tree, and the ones that exist
are worse than none:

| | count |
|---|---|
| elements | 615 |
| with a DOM id (`AXDOMIdentifier`) | 17 |
| with CSS classes (`AXDOMClassList`) | 198 |

Every one of the 17 is a framework-generated id of the form `base-ui-_r_9c_`.
Those come from React's `useId` and change between renders, so they look stable
and are not. Do not target them and do not add more.

The 198 class names are the identity the codebase already maintains — the e2e
suite targets `.maka-composer-textarea`, `.maka-list-row`, `.maka-session-panel`
today. Treat a `.maka-*` class on an interactive element as a public contract:
renaming one is a breaking change for both the e2e suite and Computer Use.

Add an explicit `id` only when a class cannot express the identity — when there
is exactly one of something and no class already names it. Spell it `cu-<area>-<thing>`
so it is obvious the id exists for automation and is not a styling hook.

## 3. Do not put machine identifiers in user-visible fields

`title` reaches the tree as `AXHelp` and reaches the user as a tooltip. It is
for help text. An identifier hidden there is a tooltip the user did not ask for.

The same goes for `aria-roledescription`: macOS renders it as the localized role
name (`按钮`, `组合框`), so overriding it replaces what the element *is* with
what we wanted to call it.

## 4. Every actionable element carries an action

The driver reads AX actions to decide what it may do. An element that responds
to a click but exposes no action is unreachable to Computer Use even when a
person can use it. In practice this means: use real `<button>`, `<a href>`,
`<input>` and the `@maka/ui` primitives built on them. A `<div onClick>` is
invisible to both audiences.

`scripts/check-a11y.mjs` already refuses icon-only buttons with no
`aria-label`, and refuses positive `tabIndex`.

## 5. Containers earn their place

Of the 615 elements, most are unnamed containers. They cost tokens in every
observation and tell neither audience anything. A wrapper that exists for layout
should not also be a landmark: give a container a `role` or an `aria-label` only
when it groups things a reader would want to skip to as a unit.

## 6. What is enforced, and what is not

Mechanical, in `scripts/check-a11y.mjs`:

- icon-only buttons need a name
- no positive `tabIndex`
- an `aria-label` may not interpolate a value the element also exposes (§1)
- a control may not rename itself while it is busy, unless its handler switches too (§1)

Not mechanical, and therefore a review responsibility:

- whether a name identifies or reports (§1's test needs the tree to answer)
- whether a container deserves a name (§5)
- whether an id is stable (§2)

When you change an interactive component, read the tree rather than reasoning
about it:

```
maka-cu/.build/release/OpenComputerUse snapshot "Maka"
```

## 7. Cleared

The five names that reported state are fixed, and no `a11y-allow` remains for
them. Each needed the value put somewhere real rather than deleted:

| control | was | is |
|---|---|---|
| permission picker | `权限模式：跳过确认` | `权限模式`, value `跳过确认` |
| project picker | `选择项目：kami-report` | `选择项目`, value as a described-by child |
| branch switcher | `切换分支：main` | `切换分支`, same shape |
| model chip | `当前模型：X` via `aria-label` on a `<span>` | a visually-hidden prefix beside the text — a static display's name is its content, and an `aria-label` only overrode it |
| new-chat / configure pickers | `…，当前 X` | constants; the picker is a combobox and reports its own value |

Measured after the change, on the running app:

```
组合框      Description: 权限模式            Value: 跳过确认
弹出式按钮   选择项目
  文本      kami-report
```

The project picker is the one worth reading twice. Dropping the value from the
name removed it from the tree entirely — the button's text is not exposed
separately once `aria-label` wins. `aria-describedby` pointing at the value span
brought it back as a child node, which is where it belongs: the name says what
pressing does, the child says what is selected.

The two `a11y-allow` comments that remain are on `removeSkillAriaLabel`, which
names which skill a row removes. That is identity, and §1's second row.
