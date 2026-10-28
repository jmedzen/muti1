#!/usr/bin/env node
/**
 * 用「真正的 node」啟動 wrangler。
 *
 * 為什麼不直接 `npx wrangler`：
 *   wrangler 的進入點 node_modules/.bin/wrangler 是 `#!/usr/bin/env node`。
 *   這台機器的 PATH 裡排在最前面的是 DSH 的 node
 *   （/Users/jm/Library/Application Support/dsh-desktop/harness/.desktop-bin/node），
 *   它其實是 Electron helper，不是 node。
 *
 *   於是 shebang 解析到 Electron → wrapper 用 Electron 去 spawn
 *   wrangler-dist/cli.js → argv 整個錯位，噴
 *     "Unknown argument: …/wrangler-dist/cli.js"
 *   看起來像參數寫錯，其實是根本沒在跑 node。
 *
 *   這裡直接以真正的 node 去執行 cli.js，跳過 shebang 與 wrapper 兩層。
 *
 * 用法：
 *   node tools/wrangler.mjs deploy --dry-run
 *   node tools/wrangler.mjs dev --port 8788
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findNode } from "./node-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");

const cli = [
  path.join(SITE, "node_modules", "wrangler", "wrangler-dist", "cli.js"),
  ...(function npxFallback() {
    const base = path.join(ROOT, ".npm-cache", "_npx");
    if (!fs.existsSync(base)) return [];
    return fs
      .readdirSync(base)
      .map((d) => path.join(base, d, "node_modules", "wrangler", "wrangler-dist", "cli.js"))
      .filter((p) => fs.existsSync(p));
  })(),
].find((p) => fs.existsSync(p));

if (!cli) {
  console.error("找不到 wrangler。請先在 site/ 目錄執行：");
  console.error("\n  cd site && npm install\n");
  process.exit(1);
}

// 工作目錄決定 wrangler 讀哪一份設定：
//   repo 根目錄 → wrangler.jsonc（assets: ./site/dist，Cloudflare CI 用這份）
//   site/       → site/wrangler.jsonc（assets: ./dist，本機用這份）
// 所以不要硬編成 SITE —— 使用者從哪裡叫，就在哪裡跑。
const cwd = process.cwd();

const child = spawn(findNode(), [cli, ...process.argv.slice(2)], {
  cwd,
  stdio: "inherit",
  env: {
    ...process.env,
    // wrangler 會想寫 ~/Library/Preferences/.wrangler，在受控環境會 EPERM
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(ROOT, ".wrangler-home"),
    WRANGLER_SEND_METRICS: "false",
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
