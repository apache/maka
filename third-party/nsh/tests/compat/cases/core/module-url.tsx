// Keep the compiler helper that resolves import.meta.url in delivered apps.
import { Text } from "nsh";
const moduleURL = new URL(import.meta.url);
export default () => <Text>{`Module URL: ${["asset:", "file:"].includes(moduleURL.protocol) && moduleURL.pathname.endsWith("module-url.tsx")}`}</Text>;
