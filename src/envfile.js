'use strict';

/**
 * 极简 .env 载入器（零依赖）
 *
 * 为什么不用 dotenv / --env-file：
 *   - 让 `npm start`、`npm test`、`node scripts/check-config.js` 三条路径行为一致
 *   - Node 的 --env-file 在文件缺失时直接报错，而这里缺失时交给 config 层给出
 *     更有指导性的错误信息
 *
 * 语义：
 *   - 已存在于 process.env 的变量优先（便于容器/K8s 注入覆盖文件）
 *   - 支持 # 注释、空行、可选的单/双引号包裹
 *   - 值中的 \n 转义会被还原（便于把多行 PEM 写成一行）
 *   - 绝不打印任何值
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {string} [envPath] .env 路径，默认项目根目录
 * @returns {{loaded:boolean, path:string}}
 */
function loadEnvFile(envPath) {
  const file = envPath || path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return { loaded: false, path: file };

  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, '\n');

    // 已存在的环境变量优先，不被文件覆盖
    if (!(key in process.env)) process.env[key] = value;
  }

  return { loaded: true, path: file };
}

module.exports = { loadEnvFile };
