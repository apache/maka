// TS7 原生 tsc 不解析 .vue SFC；此处仅为 .ts 文件里的 .vue 导入提供模块声明，
// .vue 内部类型检查待 vue-tsc 适配 TS7 后恢复（详见 README）
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
