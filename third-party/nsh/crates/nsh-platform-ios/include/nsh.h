// The C ABI under the NativeShell Swift module (`src/embed.rs`). Internal:
// apps use `import NativeShell` (`swift/NativeShell.swift`), which imports
// this module (`NativeShellC`) privately.
//
// Errors are returned as strings owned by the caller (NULL when there is
// none); free them with `nsh_string_free`. App functions must be called on the
// main thread; trust and package functions on any thread.

#pragma once

#import <UIKit/UIKit.h>
#include <stdbool.h>
#include <stdint.h>

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

/// Frees a string returned by these functions.
void nsh_string_free(char *_Nullable s);

/// An embedded nsh app.
typedef struct NshApp NshApp;

/// Creates an app view with `frame`; it then follows its superview's size.
/// `trace` logs per-commit timings. Free with `nsh_app_destroy`.
NshApp *nsh_app_create(CGRect frame, bool trace);

/// The view to add to a hierarchy. Owned by `app`.
UIView *nsh_app_view(NshApp *app);

/// Stops the app, removes its view and frees `app`.
void nsh_app_destroy(NshApp *_Nullable app);

/// Runs a bundle written by `nsh build`, replacing the running app; assets
/// are read from `assets` next to it. Bytecode (`bundle.nshc`) only loads from
/// inside the app's own bundle; elsewhere only JS source does. Returns why it
/// cannot, or NULL.
char *_Nullable nsh_app_load_bundle(NshApp *app, const char *path);

/// What the apps `app` loads are granted at most: JSON in the form of
/// `nsh.json`'s `capabilities` (NULL: what each app declares). Applies from
/// the next load. Returns why the grant is invalid, or NULL.
char *_Nullable nsh_app_set_granted_capabilities(NshApp *app, const char *_Nullable json);

/// The VM limits of the apps `app` loads next: JS heap (MB), stack (KB),
/// the time budgets (ms) of loading and of every other call into JS, and the
/// node quota; 0 keeps a default.
void nsh_app_set_limits(NshApp *app, uint32_t memory_mb, uint32_t stack_kb, uint32_t load_ms,
                        uint32_t call_ms, uint32_t max_nodes);

/// The directory the storage (`nsh/storage`) of the apps `app` loads is kept
/// in (`storage.json` in it); NULL: each app's own, `nsh/<app id>` in the
/// embedding app's Application Support (the id of `nsh.json`, `nsh/default`
/// without one). Applies from the next load. Returns why the path is invalid,
/// or NULL.
char *_Nullable nsh_app_set_storage_directory(NshApp *app, const char *_Nullable path);

/// Where an app's caches are kept (`NshCacheOptions.location`).
enum {
    /// The system's cache directory: `nsh` in the app's Caches.
    NSH_CACHE_LOCATION_SYSTEM = 0,
    /// `NshCacheOptions.directory`.
    NSH_CACHE_LOCATION_DIRECTORY = 1,
    /// Nothing on disk.
    NSH_CACHE_LOCATION_OFF = 2,
};

/// How much one cache keeps (`NshCacheOptions.images`).
enum {
    /// Its default size (images: 256 MiB).
    NSH_CACHE_POLICY_DEFAULT = 0,
    /// At most its `_max_mb` megabytes (MiB).
    NSH_CACHE_POLICY_MAX_SIZE = 1,
    /// Not kept on disk.
    NSH_CACHE_POLICY_OFF = 2,
};

/// Where the apps keep their caches and how much each keeps. Zeroed, it is
/// the default (the system's directory, default sizes). Set `size` to
/// `sizeof(NshCacheOptions)`: fields added later read as zero for callers
/// built against this header.
typedef struct {
    uint32_t size;
    /// `NSH_CACHE_LOCATION_*`.
    uint32_t location;
    /// For `NSH_CACHE_LOCATION_DIRECTORY`: each app's caches in
    /// `<directory>/<app id>`.
    const char *_Nullable directory;
    /// `NSH_CACHE_POLICY_*` of the images the apps download.
    uint32_t images;
    /// For `NSH_CACHE_POLICY_MAX_SIZE`.
    uint32_t images_max_mb;
} NshCacheOptions;

/// Where the apps `app` loads keep their caches and how much each keeps.
/// Applies from the next load. Returns why `options` are invalid, or NULL.
char *_Nullable nsh_app_set_cache(NshApp *app, const NshCacheOptions *options);

/// The embedding app's locale, standing in for the user's: a BCP 47 tag or a
/// platform identifier (`zh-Hans-CN`, `en_US`); NULL follows the system's
/// again. Applies at once and to every app loaded later. Returns why `tag` is
/// no locale, or NULL.
char *_Nullable nsh_app_set_locale(NshApp *app, const char *_Nullable tag);

/// The embedding app's text size relative to the default (1.0), standing in
/// for Dynamic Type's; 0 follows the system's again.
void nsh_app_set_font_scale(NshApp *app, float scale);

/// The embedding app's theme overrides: a theme file of shadcn/ui's
/// (`{ "cssVars": { "theme": {...}, "light": {...}, "dark": {...} } }`, as
/// `nsh.json`'s `"theme"`), whose tokens win over the app's of the same
/// names, light and dark; NULL gives the app its own theme back. Applies at
/// once and to every app loaded later. Returns why the file does not parse,
/// or NULL.
char *_Nullable nsh_app_set_theme_overrides(NshApp *app, const char *_Nullable json);

/// Development: loads from a `nsh dev` server (`ws://host:port/ws`) and
/// reloads on every change. Returns an error without development support,
/// or NULL.
char *_Nullable nsh_app_connect_dev_server(NshApp *app, const char *url);

/// Receives fatal app errors on the main thread, replacing the previous
/// handler; `release` (optional) is called with `context` when the handler
/// is replaced or the app destroyed.
void nsh_app_set_error_handler(NshApp *app,
                               void (*_Nullable handler)(void *_Nullable context, const char *message),
                               void *_Nullable context,
                               void (*_Nullable release)(void *_Nullable context));

/// The status bar the running apps asked for, for a host view controller.
UIStatusBarStyle nsh_status_bar_style(void);
bool nsh_status_bar_hidden(void);
UIStatusBarAnimation nsh_status_bar_animation(void);

/// The keys, revocations and accepted builds that signed packages are
/// verified against.
typedef struct NshTrust NshTrust;

/// A trust store kept in `state_dir` (created if needed). On failure
/// returns NULL and sets `*error`. Free with `nsh_trust_destroy`.
NshTrust *_Nullable nsh_trust_create(const char *state_dir, char *_Nullable *_Nonnull error);

/// Trusts a root public key (base64, `<name>.pub` of `nsh keygen`).
/// Returns why the key is invalid, or NULL.
char *_Nullable nsh_trust_add_root(const NshTrust *trust, const char *public_key);

/// Applies a revocation list (`nsh revoke`) signed by a trusted root and
/// newer than the one the store has. Returns why it is refused, or NULL.
char *_Nullable nsh_trust_update_revocations(const NshTrust *trust, const char *json);

void nsh_trust_destroy(NshTrust *_Nullable trust);

/// A verified package, ready to run.
typedef struct NshPackage NshPackage;

/// Verifies the signed package at `path`, extracts its assets and accepts
/// its build. Slow for large packages: call it off the main thread. On
/// refusal returns NULL and sets `*error`.
NshPackage *_Nullable nsh_trust_open_package(const NshTrust *trust, const char *path,
                                             char *_Nullable *_Nonnull error);

/// The package's app. Strings are owned by `package`.
const char *nsh_package_app_id(const NshPackage *package);
const char *nsh_package_app_name(const NshPackage *package);
const char *nsh_package_app_version(const NshPackage *package);
uint64_t nsh_package_app_build(const NshPackage *package);

/// Runs `package`, replacing the running app. Takes `package`.
void nsh_app_run_package(NshApp *app, NshPackage *package);

/// Frees a package that will not run.
void nsh_package_free(NshPackage *_Nullable package);

/// What a component tells its app (owned by the component).
typedef struct NshComponentContext NshComponentContext;

/// What nsh calls on a component the app made; every function gets the
/// handle `create` returned. Main thread.
typedef struct {
    /// Makes a component for an element; takes `context`. Returns its handle.
    void *_Nonnull (*_Nonnull create)(void *_Nullable factory, NshComponentContext *context);
    /// The component's view (owned by the component).
    UIView *_Nonnull (*_Nonnull view)(void *component);
    /// Prop `name` changed: its JSON, or NULL when removed.
    void (*_Nonnull set_prop)(void *component, const char *name, const char *_Nullable json);
    /// JS called `ref.command(name, args)`; `json` is the arguments.
    void (*_Nonnull command)(void *component, const char *name, const char *json);
    /// The element is gone: release the component.
    void (*_Nonnull destroy)(void *component);
    /// The registration is replaced or the app destroyed: release `factory`.
    void (*_Nullable release_factory)(void *_Nullable factory);
} NshComponentCallbacks;

/// Registers native component `name` (`nativeComponent(name, ...)` in JS)
/// for the elements created from now on.
void nsh_app_register_component(NshApp *app, const char *name, void *_Nullable factory,
                                const NshComponentCallbacks *callbacks);

/// Emits event `name` with `json` data (NULL: none). Any thread.
void nsh_component_emit(const NshComponentContext *context, const char *name, const char *_Nullable json);

/// The component's own size (points), used where its style leaves a
/// dimension open. Any thread.
void nsh_component_set_size(const NshComponentContext *context, double width, double height);

/// Frees a component's context.
void nsh_component_context_free(NshComponentContext *_Nullable context);

/// The launch parameters of the apps `app` loads from now on (`host.params`,
/// read when an app starts): a JSON object, or NULL for none. Returns why
/// `json` is not a JSON object, or NULL.
char *_Nullable nsh_app_set_host_params(NshApp *app, const char *_Nullable json);

/// Sends event `name` with `json` data (NULL: null) to the running app
/// (`host.on(name, ...)`); kept until it listens to `name`, or for the next
/// app while none runs. Returns why it cannot, or NULL.
char *_Nullable nsh_app_send_host_event(NshApp *app, const char *name, const char *_Nullable json);

/// A call of the app (`host.call`), answered once from any thread with
/// `nsh_host_call_resolve` or `nsh_host_call_reject`, which free it.
typedef struct NshHostCall NshHostCall;

/// Handles the app's calls (`host.call`) and posts (`host.post`) of `name`,
/// replacing the handler it had; a NULL `handler` removes it. `handler` runs on
/// the main thread with the JSON data and, for a call, the call to answer
/// (NULL for a post). `release` (optional) is called with `context`, on any
/// thread, when the handler is replaced or removed or the app destroyed.
void nsh_app_set_host_handler(NshApp *app, const char *name,
                              void (*_Nullable handler)(void *_Nullable context, const char *json,
                                                        NshHostCall *_Nullable call),
                              void *_Nullable context,
                              void (*_Nullable release)(void *_Nullable context));

/// Answers `call` with `json` (NULL: null) and frees it. Any thread.
void nsh_host_call_resolve(NshHostCall *call, const char *_Nullable json);

/// Fails `call` with `message` and frees it. Any thread.
void nsh_host_call_reject(NshHostCall *call, const char *message);

/// Frees `call` unanswered: the app's call fails. Any thread.
void nsh_host_call_free(NshHostCall *_Nullable call);

/// Takes the URLs the app opens (`openUrl` of `nsh/device`) before the system
/// does, replacing the handler it had; a NULL `handler` removes it. `handler`
/// runs on the main thread with the URL and returns true when the embedding
/// app took it, false for the system to open it. `release` (optional) is called
/// with `context`, on any thread, when the handler is replaced or removed or
/// the app destroyed.
void nsh_app_set_open_url_handler(NshApp *app,
                                  bool (*_Nullable handler)(void *_Nullable context, const char *url),
                                  void *_Nullable context,
                                  void (*_Nullable release)(void *_Nullable context));

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
