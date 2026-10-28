#!/usr/bin/env node
/**
 * 開發模式：改檔案就看到變化（不需要 Docker）
 *
 * 同時跑兩件事：
 *   1. sync --watch —— 監看 content/model.json，有變就複製到 site/src/data/
 *   2. astro dev    —— Vite 熱更新，改 .astro / .css / .json 都即時反映
 *
 * 為什麼要包這一層：
 *   astro dev 只認得 site/src/data/model.json。使用者改的是 content/model.json
 *   （那份才是「真的」內容）。少了同步這步，就會出現「我明明改了，頁面沒變」——
 *   這個坑我自己踩過，所以直接做進指令裡。
 *
 * 用法：
 *   node tools/dev.mjs                 # http://localhost:4321
 *   node tools/dev.mjs --port 5000
 *   node tools/dev.mjs --host          # 同網段手機可連
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findNode } from "./node-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = findNode();
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const PORT = arg("port", process.env.PORT || 4321);
const extra = [];
if (argv.includes("--host")) extra.push("--host");

if (!fs.existsSync(path.join(ROOT, "site", "node_modules", "astro"))) {
  console.error("找不到 astro，先在 site/ 目錄跑一次 npm install。");
  process.exit(1);
}

const children = [];
const spawnChild = (label, cmd, args, opts = {}) => {
  const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  const prefix = `[${label}]`;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) out.write(`${prefix} ${l}\n`);
    });
  };
  pipe(c.stdout, process.stdout);
  pipe(c.stderr, process.stderr);
  c.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`${prefix} 結束（code ${code}）`);
  });
  children.push(c);
  return c;
};

console.log("黃磊生官方網站 — 開發模式\n");

// 先同步一次，再開始監看
spawnChild("sync", NODE, [path.join(ROOT, "tools", "sync.mjs")], { cwd: ROOT });
setTimeout(() => {
  spawnChild("sync", NODE, [path.join(ROOT, "tools", "sync.mjs"), "--watch"], { cwd: ROOT });
}, 400);

spawnChild(
  "astro",
  NODE,
  [
    path.join(ROOT, "site", "node_modules", "astro", "bin", "astro.mjs"),
    "dev",
    "--port",
    String(PORT),
    ...extra,
  ],
  {
    cwd: path.join(ROOT, "site"),
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  }
);

const shutdown = () => {
  for (const c of children) {
    try {
      c.kill("SIGINT");
    } catch {}
  }
  setTimeout(() => process.exit(0), 300);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
