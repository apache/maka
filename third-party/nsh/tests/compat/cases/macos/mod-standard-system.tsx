// NSH-owned standard modules: shared logger, metadata, per-VM process
// state, queued callbacks and capability-denied operations: a denial is an
// `ERR_ACCESS_DENIED` error naming the capability and what was asked for,
// thrown by a synchronous function and the rejection of one returning a
// promise; a wrong use is a `TypeError`.
import { Text, View, signal } from "nsh";
import logger from "console";
import os, { EOL, arch, homedir, platform } from "os";
import runtimeProcess, { ChildProcess, arch as processArch, exit, nextTick, platform as processPlatform, run, spawn } from "process";

const lines = signal<string[]>([]);
const results: string[] = [];
function check(name: string, value: boolean) {
  results.push(`${name}=${value}`);
}
function misused(operation: () => unknown): boolean {
  try {
    operation();
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}
function isDenial(error: any, resource: string): boolean {
  // Read before `instanceof` narrows `error` to `Error`, which has no code.
  const { code, permission, resource: on } = error ?? {};
  return error instanceof Error && code === "ERR_ACCESS_DENIED"
    && permission === "process" && on === resource;
}
function denied(operation: () => unknown, resource: string): boolean {
  try {
    operation();
    return false;
  } catch (error) {
    return isDenial(error, resource);
  }
}
function rejected(operation: () => Promise<unknown>, resource: string): Promise<boolean> {
  let promise: Promise<unknown>;
  try {
    promise = operation();
  } catch {
    return Promise.resolve(false);
  }
  return promise.then(() => false, (error) => isDenial(error, resource));
}

check("console.identity", logger === console);
check("console.results", [
  logger.log("standard-system log"),
  logger.info("standard-system info"),
  logger.debug("standard-system debug"),
  logger.warn("standard-system warn"),
  logger.error("standard-system error"),
].every(value => value === undefined));
check("os.identity", os.platform === platform && os.arch === arch
  && os.homedir === homedir && os.EOL === EOL);
check("os.metadata", platform() === processPlatform && arch() === processArch
  && processPlatform.length > 0 && processArch.length > 0
  && EOL === (processPlatform === "windows" ? "\r\n" : "\n"));
// Hosts without a configured native home report the documented error.
let homeMetadata = false;
try {
  const home = homedir();
  homeMetadata = home.startsWith("/") || /^[A-Za-z]:[\\/]/.test(home) || home.startsWith("\\\\");
} catch (error: any) {
  homeMetadata = error.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM";
}
check("os.home", homeMetadata);
check("process.identity", runtimeProcess === process
  && runtimeProcess.platform === processPlatform && runtimeProcess.arch === processArch
  && runtimeProcess.run === run && runtimeProcess.spawn === spawn
  && runtimeProcess.exit === exit && runtimeProcess.nextTick === nextTick);
const firstEnvironment = runtimeProcess.env;
const secondEnvironment = process.env;
firstEnvironment.NSH_COMPAT_LOCAL = "local";
check("process.environment", firstEnvironment !== secondEnvironment
  && secondEnvironment.NSH_COMPAT_LOCAL === undefined
  && process.env.NSH_COMPAT_LOCAL === undefined);
check("process.dataDir", runtimeProcess.dataDir === process.dataDir
  && (process.dataDir === null || typeof process.dataDir === "string"));
const runDenied = rejected(() => run("nsh-compat-ungranted", []), "nsh-compat-ungranted");
check("process.spawnDenied", denied(() => spawn("nsh-compat-ungranted", []), "nsh-compat-ungranted"));
check("process.childConstructor", misused(() => new (ChildProcess as any)()));
check("process.exitDenied", denied(() => exit(7), "exit"));
check("process.nextTickInvalid", misused(() => nextTick(null as any)));

const order: string[] = [];
nextTick((a: number, b: number) => {
  order.push(String(a + b));
  process.nextTick(() => {
    check("process.nextTick", order.join(",") === "sync,5,promise");
    runDenied.then((value) => {
      check("process.runDenied", value);
      lines.set(results);
    });
  });
}, 2, 3);
Promise.resolve().then(() => order.push("promise"));
order.push("sync");

export default () => <View><Each of={lines()}>{line => <Text>{line()}</Text>}</Each></View>;
