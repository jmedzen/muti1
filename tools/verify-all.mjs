#!/usr/bin/env node
/**
 * 全部驗證一次跑完（本機環境，不需要 Docker）
 *
 * 有的驗證需要先起伺服器（deploy / serve 那兩支），這裡自動處理：
 *   - 起一支 wrangler dev（Cloudflare 路線）
 *   - 起一支 tools/serve.mjs（本機預覽路線）
 *   - 跑完自動關掉
 *
 * 用法：
 *   node tools/verify-all.mjs
 *   node tools/verify-all.mjs --fast      # 跳過視覺與效能（那兩支比較慢）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findNode, isRealNode } from "./node-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAST = process.argv.includes("--fast");
// 找 wrangler 的進入點。
//
// ⚠️ 不要用 node_modules/wrangler/bin/wrangler.js ——
//    那一支是 shell wrapper（用 child_process 再 spawn 一次），
//    傳進去的 --port 會被它吃到變成 "Unknown arguments: port, …"，
//    然後 wrangler 用預設埠起來，看起來像「port 一直被佔用」。
//    直接用 wrangler-dist/cli.js 才是真正的 CLI。
// 用 tools/wrangler.mjs 當啟動器 —— 它會自己找 wrangler 並用真正的 node 執行。
// 直接呼叫 node_modules/.bin/wrangler 會被 shebang 帶到 Electron（見該檔說明）。
const WRANGLER_LAUNCHER = path.join(ROOT, "tools", "wrangler.mjs");
const WRANGLER = fs.existsSync(WRANGLER_LAUNCHER) ? WRANGLER_LAUNCHER : null;

// 起伺服器前先確認 port 沒被別人佔著，否則會出現
// 「wrangler 說 Address already in use」卻看不出是誰佔的。
const portBusy = (port) => {
  try {
    const out = execFileSync("/usr/sbin/lsof", ["-ti", `:${port}`], { encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return []; // lsof 沒找到時 exit 1
  }
};

// 用哪個 node 來跑子行程。
//
// ⚠️ 不能用 process.execPath —— 在 DSH 這類 Electron 宿主裡，
//    它指向的是 Electron helper，傳參數給子行程時 argv 會被吃掉，
//    wrangler 就變成 "Unknown arguments: port, …"。
//    實際上這台機器的 node 在 /opt/homebrew/bin/node。
const NODE = findNode();
if (!isRealNode(NODE)) {
  console.log(`⚠️  找不到真正的 node（目前是 ${NODE}），某些子行程可能挑參數。`);
  console.log(`   可以設環境變數指定：LUISANG_NODE=/path/to/node\n`);
} else {
  console.log(`使用 node：${NODE}\n`);
}

const results = [];
const run = (name, fn) => {
  process.stdout.write(`\n${"─".repeat(60)}\n${name}\n${"─".repeat(60)}\n`);
  try {
    fn();
    results.push({ name, ok: true });
    return true;
  } catch (e) {
    console.log(String(e.stdout || "").slice(-1200));
    console.log(String(e.stderr || "").slice(-1200));
    results.push({ name, ok: false });
    return false;
  }
};

const node = (script, args = []) =>
  execFileSync(NODE, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 900000,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  });

/* ── 需要伺服器的驗證：先起、跑完關 ── */
const servers = [];
// wrangler 第一次啟動要下載 workerd、解析 94 條轉址規則，可能超過 20 秒。
// 給它 90 秒，並把輸出導到 log 檔，起不來時才看得出原因。
const waitUp = async (url, tries = 180) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status > 0) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const startServer = async (label, cmd, args, cwd, url) => {
  const logPath = path.join(ROOT, ".cache", `${label.replace(/\s+/g, "-")}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "w");

  const child = spawn(cmd, args, {
    cwd,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", WRANGLER_SEND_METRICS: "false", XDG_CONFIG_HOME: path.join(ROOT, ".wrangler-home") },
  });
  servers.push(child);
  const ok = await waitUp(url);
  if (!ok) {
    console.log(`  ${label} 起不來（${url}）— 最後幾行：`);
    try {
      const tail = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).slice(-6);
      for (const l of tail) console.log(`    ${l}`);
    } catch {}
  } else {
    console.log(`  ${label} 已就緒（${url}）`);
  }
  return ok;
};

const cleanup = () => {
  for (const s of servers) {
    try {
      s.kill("SIGKILL");
    } catch {}
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

/* ══════════════════════ 開始 */
console.log("黃磊生官方網站 — 完整驗證（本機，無需 Docker）");

// 0. 內容同步
run("0. 內容同步（兩份 model.json 一致）", () => node("tools/sync.mjs", ["--check"]));

// 1. 建置（後面很多驗證要看 dist）
const built = run("1. 建置", () => {
  execFileSync(NODE, [path.join(ROOT, "site/node_modules/astro/bin/astro.mjs"), "build"], {
    cwd: path.join(ROOT, "site"),
    stdio: "inherit",
    timeout: 300000,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  });
});

if (!built) {
  console.log("\n建置失敗，後面不用跑了。");
  process.exit(1);
}

// 2. 內容完整性
run("2. 內容完整性", () => node("tools/verify-content.mjs"));
// 3. 連結與資源
run("3. 連結與資源", () => node("tools/link-check.mjs"));
// 4. 來源列舉（需要網路）
run("4. 來源列舉（原站 vs 已抓取）", () => node("tools/verify-source.mjs", ["--limit", "300"]));
// 5. Docker 建置模擬
run("5. Docker 建置模擬", () => node("tools/verify-docker.mjs"));

/* ── 6/7：需要伺服器 ── */
const main = async () => {
  // 先清 port，不然會撞到上一輪沒關乾淨的 wrangler
  for (const port of [8788, 4321]) {
    const busy = portBusy(port);
    if (busy.length) {
      console.log(`  port ${port} 被佔用（${busy.join(", ")}），先清掉`);
      for (const pid of busy) {
        try {
          execFileSync("/bin/kill", ["-9", pid]);
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const cfUp = WRANGLER
    ? await startServer(
        "wrangler dev",
        NODE,
        [WRANGLER, "dev", "--port", "8788"],
        path.join(ROOT, "site"),
        "http://localhost:8788/"
      )
    : false;

  const localUp = await startServer(
    "本機預覽伺服器",
    NODE,
    [path.join(ROOT, "tools", "serve.mjs"), "--port", "4321"],
    ROOT,
    "http://127.0.0.1:4321/"
  );

  if (cfUp) {
    run("6. 部署驗證（Cloudflare 路線 + nginx 規則）", () => node("tools/verify-deploy.mjs"));
  } else {
    console.log(
      WRANGLER
        ? "\n（略過部署驗證：wrangler 沒起來，看 .cache/wrangler-dev.log）"
        : "\n（略過部署驗證：找不到 tools/wrangler.mjs）"
    );
    results.push({ name: "6. 部署驗證", ok: null });
  }

  if (cfUp && localUp) {
    run("7. 本機預覽 vs Cloudflare 行為一致", () =>
      node("tools/verify-serve.mjs", ["--local", "4321", "--cf", "8788"])
    );
  } else {
    console.log("\n（略過預覽對照：兩個伺服器都要起來）");
    results.push({ name: "7. 預覽對照", ok: null });
  }

  /* ── 慢的兩支 ── */
  if (!FAST) {
    if (localUp) {
      run("8. 視覺與響應式（1440 / 768 / 390）", () =>
        execFileSync(
          NODE,
          [path.join(ROOT, "tools/visual-check.mjs"), "--width", "1440,768,390", "--max", "60", "--base", "http://127.0.0.1:4321"],
          { cwd: ROOT, stdio: "inherit", timeout: 1800000, env: { ...process.env } }
        )
      );
    }
    if (localUp) {
      run("9. 效能（4G 模擬）", () =>
        execFileSync(NODE, [path.join(ROOT, "tools/perf.mjs"), "--url", "http://127.0.0.1:4321"], {
          cwd: ROOT,
          stdio: "inherit",
          timeout: 1800000,
          env: { ...process.env },
        })
      );
    }
  } else {
    console.log("\n（--fast：跳過視覺與效能）");
    results.push({ name: "8. 視覺", ok: null }, { name: "9. 效能", ok: null });
  }

  cleanup();

  /* ── 總結 ── */
  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  const skip = results.filter((r) => r.ok === null).length;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`總結：${pass} 通過、${fail} 失敗、${skip} 略過`);
  for (const r of results) {
    const mark = r.ok === true ? "✓" : r.ok === false ? "✗" : "–";
    console.log(`  ${mark} ${r.name}`);
  }
  console.log(`${"═".repeat(60)}\n`);

  process.exit(fail ? 1 : 0);
};

main();
