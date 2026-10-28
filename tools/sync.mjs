#!/usr/bin/env node
/**
 * 內容編譯與同步
 *
 * 資料流向（改版後）：
 *
 *   content/md/ 底下的 .md       ← 你唯一要編輯的地方
 *         │  tools/md-to-model.mjs（編譯）
 *         ▼
 *   content/model.json          ← 產物：給 12 個驗證工具用
 *         │  tools/sync.mjs（複製）
 *         ▼
 *   site/src/data/model.json    ← 產物：Vite 只能 import 專案內的檔案
 *
 * 為什麼要這樣繞：
 *   驗證工具（verify-content、redirects、images…）在 repo 根目錄跑，
 *   Astro 只能 import site/ 裡的檔案。與其讓兩邊各有一套資料，
 *   不如從同一批 Markdown 編譯出兩份形狀相同的 JSON。
 *
 * 重點：使用者永遠只編輯 content/md/ 底下的 Markdown。
 *   `content/model.json` 與 `site/src/data/model.json` 都是產物，
 *   手改會在下次 build 時被覆蓋。
 *
 * 用法：
 *   node tools/sync.mjs            # 編譯 MD → model.json，並同步到 site/
 *   node tools/sync.mjs --check    # 只檢查兩份 model.json 是否一致（CI 用）
 *   node tools/sync.mjs --watch    # 監看 content/md/，有變就重編
 *   node tools/sync.mjs --no-build # 只複製，不重新編譯（除錯用）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { findNode } from "./node-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "content", "model.json");
const DST = path.join(ROOT, "site", "src", "data", "model.json");
const MD = path.join(ROOT, "content", "md");

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const WATCH = args.includes("--watch");
const NO_BUILD = args.includes("--no-build");

/**
 * 從 Markdown 編譯出 model.json。
 *
 * --check 模式不編譯：它要驗的是「兩份 model.json 是否一致」，
 * 若順手重新編譯，就永遠一致了，那個檢查就失去意義。
 */
function compile({ quiet = false } = {}) {
  if (NO_BUILD || CHECK) return true;
  if (!fs.existsSync(MD)) {
    console.error(`找不到 ${MD}
先跑 node tools/md-from-model.mjs 從既有 model.json 產生 MD。`);
    return false;
  }
  const r = spawnSync(findNode(), [path.join(ROOT, "tools", "md-to-model.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(r.stdout || "");
    console.error(r.stderr || "");
    console.error("✗ 從 Markdown 編譯 model.json 失敗");
    return false;
  }
  if (!quiet) {
    // md-to-model 自己會印摘要，這裡只補一行來源說明
    console.log("（來源：content/md/）");
  }
  return true;
}

if (!CHECK && !compile()) process.exit(1);

if (!fs.existsSync(SRC)) {
  console.error(`找不到 ${SRC}\n先跑 node tools/md-to-model.mjs 從 content/md/ 產生它。`);
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
  console.log(`監看 ${path.relative(ROOT, MD)}（Ctrl+C 結束）`);
  compile();
  sync();
  let timer = null;
  // 遞迴監看 content/md/：改任何一個 .md 都重編
  fs.watch(MD, { recursive: true }, (_e, file) => {
    if (!file || !String(file).endsWith(".md")) return;
    // 編輯器存檔常常觸發兩次，去抖一下
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        compile({ quiet: true });
        sync({ quiet: true });
      } catch (e) {
        console.error("重編失敗：", e.message);
      }
    }, 120);
  });
} else {
  const ok = sync();
  process.exit(ok ? 0 : 1);
}
