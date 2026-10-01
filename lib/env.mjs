// lib/env.mjs
//
// 零依赖的 .env 读取器。
//
// 目的:让"可选配置"既能用环境变量传,也能写进项目根目录的 .env 文件
//       (不用额外装 dotenv)。
//
// 行为:
//   - 文件不存在 → 静默跳过,不影响运行
//   - 只解析 `KEY=VALUE` 与 `# 注释`;支持 `export KEY=VALUE` 与成对引号
//   - **不覆盖**已存在的进程环境变量(即 shell 里 export 的优先级更高)
//   - 任何解析异常都被吞掉,绝不阻断主流程
//
// 用法:
//   import { loadDotEnv } from "./lib/env.mjs";
//   loadDotEnv(path.join(__dirname, ".env"));   // 在读取 process.env 之前调用

import fs from "node:fs";

/**
 * 读取 .env 并写入 process.env(已存在的键不覆盖)。
 * @param {string} envPath .env 文件绝对路径
 * @returns {boolean} 是否成功读取到文件
 */
export function loadDotEnv(envPath) {
  try {
    if (!fs.existsSync(envPath)) return false;

    const text = fs.readFileSync(envPath, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;

      const eq = line.indexOf("=");
      if (eq <= 0) continue;

      const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
      let value = line.slice(eq + 1).trim();

      // 去掉成对的单/双引号
      const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      if (quoted && value.length >= 2) value = value.slice(1, -1);

      if (key && !(key in process.env)) process.env[key] = value;
    }
    return true;
  } catch {
    return false; // 读不了就当没有 .env
  }
}
