#!/usr/bin/env node
/**
 * 確保 site/ 的相依套件已安裝。
 *
 * 為什麼需要這一支：
 *   Cloudflare Workers Builds（Git 整合）會用預設的 install / build 指令跑，
 *   而「預設」不一定等於我們的目錄結構。實際遇到的錯誤是：
 *
 *     > luisang-museum@1.0.0 build
 *     sh: 1: astro: not found
 *
 *   意思是 build 被叫起來了，但 site/node_modules 不存在 ——
 *   install 那一步沒發生在 site/（或根本沒跑）。
 *
 *   與其在文件裡叮嚀「記得把 Root directory 設成 site」，
 *   不如讓 build 自己處理：缺什麼就裝什麼。這樣不論平台從哪個目錄叫它，
 *   行為都一致 —— 這正是「同時兼容本地與 Cloudflare」該有的樣子。
 *
 * 行為：
 *   - site/node_modules/astro 存在 → 什麼都不做（本機日常，幾乎零成本）
 *   - 不存在 → 跑 npm ci（有 lockfile）；失敗才退回 npm install
 *
 * 用法：
 *   node tools/ensure-deps.mjs           # 檢查並視需要安裝
 *   node tools/ensure-deps.mjs --check   # 只檢查，缺了就 exit 1
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findNode } from "./node-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const CHECK_ONLY = process.argv.includes("--check");

// 這幾個套件缺任何一個都建不起來
const REQUIRED = ["astro", "sharp"];

const missing = REQUIRED.filter(
  (pkg) => !fs.existsSync(path.join(SITE, "node_modules", pkg, "package.json"))
);

if (missing.length === 0) {
  // 本機最常見的情況：已經裝好了，安靜通過
  if (process.argv.includes("--verbose")) console.log("✓ site/node_modules 已就緒");
  process.exit(0);
}

if (CHECK_ONLY) {
  console.error(`✗ site/node_modules 缺少：${missing.join(", ")}`);
  console.error("  在 site/ 目錄執行 npm install");
  process.exit(1);
}

console.log(`site/node_modules 缺少 ${missing.join(", ")}，開始安裝…`);

// 用真正的 node 去跑 npm —— 這台機器的 PATH 裡 node 可能是 Electron（見 node-path.mjs）
const nodeBin = findNode();
const npmCli = [
  path.join(path.dirname(nodeBin), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
  "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  "/usr/lib/node_modules/npm/bin/npm-cli.js",
].find((p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});

const run = (args, label) => {
  console.log(`  ${label}`);
  const cmd = npmCli ? nodeBin : "npm";
  const argv = npmCli ? [npmCli, ...args] : args;
  execFileSync(cmd, argv, {
    cwd: SITE,
    stdio: "inherit",
    timeout: 900000,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  });
};

const hasLock = fs.existsSync(path.join(SITE, "package-lock.json"));

try {
  if (hasLock) {
    run(["ci", "--no-audit", "--no-fund"], "npm ci（依 package-lock.json）");
  } else {
    run(["install", "--no-audit", "--no-fund"], "npm install");
  }
} catch {
  // npm ci 在 lockfile 與 package.json 不同步時會失敗 —— 退回 install
  if (hasLock) {
    console.log("  npm ci 失敗，改用 npm install");
    run(["install", "--no-audit", "--no-fund"], "npm install");
  } else {
    throw new Error("相依套件安裝失敗");
  }
}

const stillMissing = REQUIRED.filter(
  (pkg) => !fs.existsSync(path.join(SITE, "node_modules", pkg, "package.json"))
);
if (stillMissing.length) {
  console.error(`✗ 安裝後仍缺少：${stillMissing.join(", ")}`);
  process.exit(1);
}

console.log("✓ 相依套件就緒");
