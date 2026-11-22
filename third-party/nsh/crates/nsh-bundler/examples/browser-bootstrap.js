// The bundle runs inside each app iframe, before its first module script.
import * as scope from "../../nsh-platform-web/web/browser/scope.js";
globalThis.__nsh_browser_bootstrap(scope);
