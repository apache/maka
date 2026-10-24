---
title: Goals and design principles
description: "Native Shell's goals: native views and interaction, app-owned design, shared components, and Rust and TSX on one engine."
order: 1.5
group: start
---

Native Shell provides native views and interaction across iOS, Android, macOS, Windows, Linux and the web. The app owns its visual design. One component model serves whole apps, embedded features and dynamically delivered UI.

## Native foundations, app-owned design

NSH builds on each platform's views, text and input infrastructure, and adapts interaction to the device: keyboard navigation, pointer and touch input, text editing, scrolling and accessibility ([Introduction](./index.md#what-native-means)).

The app defines colors, typography, spacing, shapes, state feedback and animation. A settings screen can follow the app's brand on iOS and Android while input and navigation follow each device's conventions. Designers refine that visual language through styles and component parts.

A native view is the rendering foundation. A system-styled control is a particular visual and behavioral choice. NSH's common controls expose shared behavior and customizable parts so applications can build their own design systems.

## Native integration in practice

The native foundation includes rendering, frame-driven animation, input and accessibility semantics. On iOS and Android, [Input](../elements/input.md) uses platform text fields: the platform handles editing, selection menus, input methods and supported autofill services. The app describes the field through `autoComplete`, for example `current-password` or `postal-code`, and the system provides the available suggestions according to its settings and services ([Forms and keyboard](./forms-and-keyboard.md)). Styling the field is compatible with keeping this system integration.

This is an architectural distinction from drawing a text field entirely within a custom renderer: a custom renderer supplies its own integration with system editing and accessibility services, while NSH uses platform text controls where its backend provides them. Each backend's documentation defines its integration, including NSH's own editor on Windows and the GPUI embedding backend ([Platforms](./platforms.md)).

[GPUI Kit](https://gpui-kit.com)'s separation of component behavior from visual design informs NSH's layers. NSH builds on that principle with platform view and input infrastructure. Native integration and app-owned design work together throughout this model.

## One component model across platforms

A switch means the same thing on a phone, a desktop and the web. [`nsh/base`](../modules/nsh-base.md) provides state, input handling, focus and accessibility; the app styles the [Switch](../elements/switch.md)'s track, thumb and states. Buttons, checkboxes and radios follow the same principle.

| Responsibility | Home | Example |
|---|---|---|
| Rendering, layout, reactivity and environment | `nsh-core`, `nsh` and runtime modules | Views, text, signals, styles |
| Shared behavior and accessible structure | `nsh-base`, imported as `nsh/base` in TSX | `Button`, `Checkbox`, `Switch`, `Tabs` |
| Visual design and styled components | The app or a community library | Branded controls, cards, form rows |
| Platform-specific capabilities | `nsh/mobile`, `nsh/desktop`, `nsh/ios`, `nsh/android` | Mobile navigation bar, desktop window controls |

Common controls have one cross-platform home in `nsh/base`. Platform modules are scoped by purpose and platform semantics. [`TabBar`](../modules/nsh-mobile.md#tabbar) serves mobile top-level navigation; [`Tabs`](../elements/tabs.md) switches tabbed content across platforms. Their roles are distinct. `nsh/mobile` accepts capabilities with mobile-specific interaction semantics; differences in a common control’s appearance, size, tint or animation belong within its shared component and app styling. A notification or toast with a shared role should first be designed around one cross-platform contract, with presentation adapted internally.

A shared component can adapt its interaction internally: a menu opens as a popup on a desktop and a sheet on a phone, while the app uses one API and supplies its appearance. System-managed presentations such as navigation headers and alerts follow their documented platform presentation rules. Apps can expose their own native components and services through the [embedding interfaces](./native-components.md).

## The unstyled foundation and the component-library layer

NSH owns the primitives and the unstyled foundation (`nsh-core` and `nsh-base`). Applications and third-party libraries own the styled component-library layer — the role `gpui-component` plays in [GPUI Kit](https://gpui-kit.com). This division gives each product control over its visual language while reusing the difficult parts of component implementation.

The experience behind this choice comes from [GPUI Kit](https://gpui-kit.com). Its styled components grew from work on Longbridge Pro. As applications needed increasingly different designs, customization pressure led users to fork components. Extracting the shared foundation into `gpui-base` made behavior reusable across those designs. Styled components remain useful as a design reference and for applications whose needs fit their customization surface; the foundation gives other applications direct control over presentation.

NSH applies this lesson from the start. `nsh/base` owns complex behavior, interaction, reactive state, focus, accessibility and adaptive presentation, with tests at the layer that owns each behavior. This includes larger structures such as [Dock](../elements/dock.md). Applications build diverse designs on that foundation through styles, states, slots and parts. Component contributions follow the same boundary: visual defaults and branded variants belong to application or third-party components. The documented system-managed presentations and `TextView` reading defaults retain their specific contracts ([Architecture](./architecture.md#three-layers)).

### What the Gallery demonstrates

The website demos and Gallery are styled example applications. Their gradients, shadows, rounded corners, transitions and motion exercise NSH's customization capabilities and provide source examples. Those choices belong to the demos and Gallery; the reusable base components expose the behavior and parts underneath them. Applications can borrow the examples or build a different visual language.

An independently distributed styled library would belong to the application/community layer described above. Gallery styling illustrates one design direction; suitability for a particular product is a design decision for that product.

## Rust and TSX on one engine

Rust apps, TSX screens and mixed projects share primitives, base components, signals and layout. Rust provides compiled application logic and reusable native components. TSX supports rapid iteration and modules delivered at run time ([Building with Rust](./rust.md)).

The engine updates bindings that depend on changed signals and batches view operations. Text layout, native animations and input belong to the engine and its platform backends ([Architecture](./architecture.md)). Performance is evaluated with reproducible application workloads ([Performance](./performance.md)).

## Embedding, dynamic delivery and AI

An existing native app places an NSH view where a feature belongs and exposes its own native components and host services. Standalone apps use the same runtime and component model ([Platforms](./platforms.md)).

Dynamically delivered TSX modules own their state, logic and layout. Signed packages establish which publishers the host trusts; sandbox limits and capabilities define what modules may do. The host chooses both trust and permissions ([Signed packages](./signed-packages.md), [Sandbox and capabilities](./sandbox-and-capabilities.md)).

AI-generated UI follows that contract: generate TSX against declared APIs, check and test it, build and sign the module, then verify and run it under host policy. Generated declarations, model-readable documentation and CLI tests make the workflow inspectable and repeatable ([Testing and tracing](./testing-and-trace.md)).

## How these goals guide additions

1. Establish the user behavior and whether it is shared across platforms.
2. Put shared behavior in the existing primitive or base component, exposing state and parts for app customization.
3. Put capabilities with platform-specific semantics in their platform module, documenting applicability and composition with shared UI.
4. Build styled components in the app or community library.
5. Verify behavior, accessibility, layout and input on affected platforms, and document the public contract in both languages.

These principles keep visual design flexible, shared component APIs coherent and platform integration explicit as NSH grows.
