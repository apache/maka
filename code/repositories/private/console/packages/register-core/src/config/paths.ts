/**
 * 包内置静态配置目录(config/*.json)解析。
 * i18n.json/selectors.json 随包分发,按包位置定位,不依赖进程 CWD;
 * 用户级配置(.env/config.json/DB 路径)仍由 loader 按 CWD 解析。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const bundledConfigDir: string = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../config');
