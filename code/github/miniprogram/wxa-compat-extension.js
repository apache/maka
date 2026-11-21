/**
 * wxa-runner 浏览器调试兼容扩展（配合 fork 版 wxa-runner 的 jsTransform 扩展点使用）
 *
 * 适用范围（2026-11-13 实测划分）：
 * - 仅旧仓 E:\Projects\senior\frontend\mp\mp-c-terminal-wxapp（Taro 3.4.3 产物）需要本扩展。
 * - 现行仓 mp-c-terminal-wxapp-xiangyang（Taro 4.3.2）+ wxa-runner ≥0.13.1 零扩展直跑，
 *   不要给它挂本扩展；登录问题用 --devtools-login / setup 解决，也不归本扩展管
 *   （见 E:\cc\github\miniprogram\wxa-runner-浏览器调试小程序教程.md 第三节）。
 *
 * 启动：node <fork>/packages/cli/bin/wxa-runner.js dev ./dist --extension ./wxa-compat-extension.js
 *
 * 两类兼容问题都只在浏览器运行时出现（真机 / 开发者工具不受影响）：
 *
 * 1. 所有模块：分包里 @ai-xiaoc/core / swr 风格的依赖在模块顶层注册
 *    `window.addEventListener("visibilitychange"/"focus", fn, !1)`（页面可见性轮询守卫）。
 *    模块沙箱里该标识符是 Taro 全局垫片对象（有 document 没有 addEventListener），
 *    "是否在浏览器" 的探测成立，模块加载即抛 TypeError，对应页面打不开。
 *
 * 2. 仅 taro.js（Taro 3.4.3 产物）：全局垫片把宿主全局的可枚举属性逐个拷给垫片对象
 *    `br[e]=i[e]`，其中带 getter 的全局（基础库伴生 SDK 的 cloud 等）在浏览器里读取
 *    会失败，拷贝循环抛 TypeError，沿 require 链炸掉 app.js，小程序无法启动。
 *    fork 版 runner 已把基础库的 loadSdkSubPackage Fatal 降级为 warn + undefined
 *    （见 baselibCompat.ts），但拷贝的属性读取链上还有别的失败方式，这里兜底守卫。
 *
 * 两类都是表达式级包裹（行数不变，DevTools 报错行号仍对应源文件），且幂等。
 *
 * ponytail: 只守卫注册/拷贝动作，不模拟事件派发、不补 SDK 能力；依赖升级后模式变了再补
 */

const GUARD = '__wxaBrowserStub';

const call = String.raw`[\w$]+\.addEventListener\((?:"visibilitychange"|"focus"),[\w$]+,!1\)`;
const listenerChains = new RegExp(`${call}(?:,${call})*`, 'g');

module.exports = {
  name: 'wxa-compat-extension',
  setup() {
    return {
      jsTransform(code, file) {
        // 兼容补丁按目标文件路由，避免无关模块被误改
        if (file === 'taro.js') return patchShimGlobalCopy(code);
        return patchVisibilityListeners(code);
      }
    };
  }
};

/** taro.js：垫片拷贝宿主全局属性的循环，读取失败时跳过该属性 */
function patchShimGlobalCopy(code) {
  const needle = 'br[e]=i[e]';
  if (!code.includes(needle) || code.includes(`br[e]=(function(){try{return i[e]}`)) return code;
  return code.replace(needle, `br[e]=(function(){try{return i[e]}catch(${GUARD}){return void 0}})()`);
}

/** 全局 addEventListener 注册失败时跳过（含逗号链，单遍匹配避免二次包裹） */
function patchVisibilityListeners(code) {
  if (!code.includes('.addEventListener("visibilitychange') && !code.includes(".addEventListener('visibilitychange")) return code;
  if (code.includes(GUARD)) return code;
  return code.replace(listenerChains, match => `(function(){try{${match}}catch(${GUARD}){}})()`);
}
