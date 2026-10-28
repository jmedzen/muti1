/**
 * 找出「真正的 node」執行檔路徑。
 *
 * 為什麼需要這個小模組：
 *   在 DSH / Electron 這類宿主裡，process.execPath 指向的是 Electron helper，
 *   不是 node。用它去 spawn 子行程時，argv 會被吃掉 ——
 *   實際症狀是 wrangler 冒出 "Unknown arguments: port, …"，
 *   看起來像參數寫錯，其實是根本沒在跑 node。
 *
 *   所有需要 spawn node 子行程的工具都該用這個，不要直接用 process.execPath。
 */
import fs from "node:fs";

export function findNode() {
  const candidates = [
    process.env.LUISANG_NODE,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    process.execPath,
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return process.execPath;
}

export const isRealNode = (p) => !/DSH|Electron|Helper/i.test(p);
