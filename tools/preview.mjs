#!/usr/bin/env node
/**
 * 一鍵本機預覽：同步內容 → 建置 → 起伺服器
 *
 * 日常最常用的其實就這三步，但每次手打很容易漏掉「同步」那步 ——
 * 漏了就會出現「我明明改了，怎麼沒變」。
 *
 * 用法：
 *   node tools/preview.mjs               # 建置後起伺服器（預設 4321）
 *   node tools/preview.mjs --port 8080
 *   node tools/preview.mjs --no-build    # 已經建置過，直接起
 *   node tools/preview.mjs --host        # 讓同網段手機也能看
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findNode } from "./node-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = findNode();
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const NO_BUILD = argv.includes("--no-build");
const PORT = arg("port", process.env.PORT || 4321);
const HOST_FLAG = argv.includes("--host") ? ["--host"] : [];

const step = (label) => console.log(`\n▸ ${label}`);

if (!NO_BUILD) {
  step("同步內容（content/model.json → site/src/data/model.json）");
  execFileSync(NODE, [path.join(ROOT, "tools", "sync.mjs")], { stdio: "inherit" });

  step("建置（Astro）");
  try {
    execFileSync(NODE, [path.join(ROOT, "site", "node_modules", "astro", "bin", "astro.mjs"), "build"], {
      cwd: path.join(ROOT, "site"),
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
      timeout: 300000,
    });
  } catch {
    console.error("\n建置失敗，中止。");
    process.exit(1);
  }
} else {
  if (!fs.existsSync(path.join(ROOT, "site", "dist", "index.html"))) {
    console.error("dist/ 不存在，不能跳過建置。拿掉 --no-build 再試一次。");
    process.exit(1);
  }
  step("跳過建置（--no-build）");
}

step("起預覽伺服器");
const child = spawn(
  NODE,
  [path.join(ROOT, "tools", "serve.mjs"), "--port", String(PORT), ...HOST_FLAG],
  { stdio: "inherit" }
);

const shutdown = () => {
  child.kill("SIGINT");
  setTimeout(() => process.exit(0), 200);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code) => process.exit(code ?? 0));
