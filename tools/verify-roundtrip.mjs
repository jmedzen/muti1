#!/usr/bin/env node
/**
 * 往返一致性驗證：content/md/ → content/model.json → content/md/
 *
 * 為什麼需要這一支
 * ────────────────
 * 內容現在只存在於 content/md/ 的 Markdown 裡，model.json 是編譯產物。
 * 這代表「編譯器吃掉了什麼」不會有人發現 —— 除非有人去看。
 *
 * 實際踩過的坑（都是靜默的，畫面上看不出來）：
 *   · 原文「B3~4頁」的 ~ 被 GFM 當成刪除線，渲染後 ~ 消失
 *   · 原文 &lt;藝術概論&gt; 被雙重轉義，瀏覽器顯示字面的 &amp;lt;
 *   · 照片日期 1996-11-21 退化成 1996（只保留年份）
 *   · 相簿排列順序從「新→舊」變成「編號順序」
 *   · 選單的葉節點多了 children: [] 這個鍵
 *   · 電話 +886289935275 被 YAML 當成數字，+ 與前導 0 消失
 *
 * 所以這支檢查兩件事：
 *   1. 結構往返：md → model → md 之後，Markdown 是否逐位元組相同
 *   2. 資料保真：重新編譯出的 model.json 與現有的逐位元組相同
 *
 * 用法：node tools/verify-roundtrip.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findNode } from "./node-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = findNode();
const MD = path.join(ROOT, "content", "md");
const MODEL = path.join(ROOT, "content", "model.json");

let failed = 0;
const fail = (msg, detail) => {
  failed++;
  console.log(`  ✗ ${msg}`);
  if (detail) console.log(detail.split("\n").slice(0, 12).map((l) => `      ${l}`).join("\n"));
};
const pass = (msg) => console.log(`  ✓ ${msg}`);

const run = (script, args = [], opts = {}) => {
  try {
    const out = execFileSync(NODE, [path.join(ROOT, "tools", script), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
      ...opts,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout || "") + (e.stderr || "") };
  }
};

/* ─────────────────────────────────────── 收集所有 MD 的內容 */
function snapshot(dir) {
  const map = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) map.set(path.relative(dir, p), fs.readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return map;
}

console.log("Markdown 往返一致性");

/* ────────────────────────────── 1. 編譯一次，確認與現有 model.json 相同 */
{
  const before = fs.readFileSync(MODEL, "utf8");
  const r = run("md-to-model.mjs");
  if (!r.ok) {
    fail("編譯 content/md/ 失敗", r.out);
  } else {
    const after = fs.readFileSync(MODEL, "utf8");
    // generatedAt 是時間戳，本來就會變
    const strip = (s) => s.replace(/"generatedAt":\s*"[^"]*"/, '"generatedAt":""');
    if (strip(before) === strip(after)) {
      pass("md → model.json 編譯結果穩定（除時間戳外逐位元組相同）");
    } else {
      fail("編譯結果與現有 model.json 不同（有人手改了產物，或編譯器行為變了）");
    }
  }
}

/* ────────────────────────────── 2. 反向：model.json → md，比對是否逐位元組相同 */
{
  const before = snapshot(MD);

  // md-from-model 會直接覆寫 content/md/，所以：備份 → 重生成 → 比對 → 還原
  const regen = run("md-from-model.mjs", ["--force"]);
  if (!regen.ok) {
    fail("model.json → md 重生失敗", regen.out);
  } else {
    const after = snapshot(MD);
    let added = 0,
      removed = 0,
      changed = 0;
    const diffs = [];

    for (const [k, v] of after) {
      if (!before.has(k)) {
        added++;
        diffs.push(`+ ${k}`);
      } else if (before.get(k) !== v) {
        changed++;
        const old = before.get(k);
        let i = 0;
        while (i < old.length && i < v.length && old[i] === v[i]) i++;
        diffs.push(
          `~ ${k} @${i}\n    舊: ${JSON.stringify(old.slice(Math.max(0, i - 20), i + 40))}\n    新: ${JSON.stringify(v.slice(Math.max(0, i - 20), i + 40))}`
        );
      }
    }
    for (const k of before.keys()) {
      if (!after.has(k)) {
        removed++;
        diffs.push(`- ${k}`);
      }
    }

    if (added + removed + changed === 0) {
      pass(`model.json → md 逐位元組可還原（${after.size} 個檔案）`);
    } else {
      fail(`往返後有差異：新增 ${added}、刪除 ${removed}、變更 ${changed}`, diffs.slice(0, 6).join("\n"));
    }
  }

  // 不管結果如何都還原，避免把 repo 留在半途狀態
  for (const [k, v] of before) {
    const fp = path.join(MD, k);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, v);
  }
  // 刪掉重生過程中多出來的檔案
  for (const k of snapshot(MD).keys()) {
    if (!before.has(k)) fs.rmSync(path.join(MD, k), { force: true });
  }
}

/* ────────────────────────────── 3. 兩份 model.json 必須一致 */
{
  const a = fs.readFileSync(MODEL, "utf8");
  const b = fs.readFileSync(path.join(ROOT, "site", "src", "data", "model.json"), "utf8");
  if (a === b) pass("content/ 與 site/src/data/ 的 model.json 一致");
  else fail("兩份 model.json 不一致（跑 node tools/sync.mjs）");
}

console.log(failed === 0 ? "\n往返一致性：通過" : `\n往返一致性：${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
