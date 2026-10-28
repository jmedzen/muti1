#!/usr/bin/env node
/**
 * 內容同步：content/model.json → site/src/data/model.json
 *
 * 為什麼需要這一支：
 *   `model.json` 有兩份 —— 一份在 `content/`（人看的、驗證腳本讀的），
 *   一份在 `site/src/data/`（Astro 直接 import 的）。
 *   Vite 只能 import 專案內的檔案，所以不得不放兩份。
 *
 *   但「兩份要手動保持一致」是注定會出錯的設計。
 *   所以：使用者永遠只編輯 `content/model.json`，
 *   這支程式在每次 dev / build 之前自動複製過去。
 *
 *   如果兩份內容不同（例如有人直接改了 site/ 那份），會警告並以 content/ 為準。
 *
 * 用法：
 *   node tools/sync.mjs            # 同步一次
 *   node tools/sync.mjs --check    # 只檢查，不同步（CI 用）
 *   node tools/sync.mjs --watch    # 監看 content/ 有變就同步
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "content", "model.json");
const DST = path.join(ROOT, "site", "src", "data", "model.json");

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const WATCH = args.includes("--watch");

if (!fs.existsSync(SRC)) {
  console.error(`找不到 ${SRC}\n先跑 node tools/model.mjs 產生它。`);
  process.exit(1);
}

const same = () => {
  if (!fs.existsSync(DST)) return false;
  return fs.readFileSync(SRC).equals(fs.readFileSync(DST));
};

function sync({ quiet = false } = {}) {
  const before = fs.existsSync(DST) ? fs.statSync(DST).size : 0;
  const wasSame = same();
  fs.mkdirSync(path.dirname(DST), { recursive: true });
  fs.copyFileSync(SRC, DST);
  const after = fs.statSync(DST).size;

  if (CHECK) {
    if (!wasSame) {
      console.error(`✗ 兩份 model.json 不一致（${before} → ${after} bytes）`);
      return false;
    }
    if (!quiet) console.log("✓ 兩份 model.json 一致");
    return true;
  }

  if (!quiet) {
    console.log(wasSame ? "✓ model.json 已同步（內容未變）" : `✓ model.json 已同步（${(after / 1024).toFixed(0)} KB）`);
  }
  return true;
}

if (WATCH) {
  console.log(`監看 ${path.relative(ROOT, SRC)}（Ctrl+C 結束）`);
  sync();
  let timer = null;
  fs.watch(path.dirname(SRC), (_e, file) => {
    if (file !== "model.json") return;
    // 編輯器存檔常常觸發兩次，去抖一下
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        if (!same()) sync({ quiet: true });
      } catch (e) {
        console.error("同步失敗：", e.message);
      }
    }, 120);
  });
} else {
  const ok = sync();
  process.exit(ok ? 0 : 1);
}
