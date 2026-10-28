/**
 * 從 site/node_modules 載入相依套件。
 *
 * 問題：
 *   puppeteer-core、sharp 這些是裝在 site/ 裡的（那是專案的 package.json）。
 *   但 tools/ 底下的腳本在 repo 根目錄，Node 的模組解析會從 tools/ 往上找，
 *   找到的是根目錄的 node_modules —— 那裡沒有這些套件。
 *
 *   之前的解法是在根目錄放一個 node_modules 符號連結指到 site/node_modules，
 *   但那很脆弱：`npm install` 在根目錄跑一次就會把它覆蓋掉，
 *   而且看起來像根目錄有自己的依賴（其實沒有）。
 *
 * 現在改成明示地在 runtime 從 site/node_modules 載入，
 * 不管從哪個目錄執行都找得到。
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE_MODULES = path.join(ROOT, "site", "node_modules");

const requireFromSite = createRequire(path.join(SITE_MODULES, "noop.js"));

/**
 * 同步載入 CJS 套件（puppeteer-core、sharp 都是 CJS）。
 * 找不到時給出「請在 site/ 跑 npm install」這種可行動的訊息。
 */
export function requireDep(name) {
  try {
    return requireFromSite(name);
  } catch (e) {
    throw new Error(
      `找不到套件 "${name}"。\n` +
        `請先在 site/ 目錄執行：\n\n  cd site && npm install\n\n` +
        `（原始錯誤：${e.message}）`
    );
  }
}

/** 動態 import ESM 套件（若有） */
export async function importDep(name) {
  const resolved = requireFromSite.resolve(name);
  return import(resolved.startsWith("file:") ? resolved : "file://" + resolved);
}
