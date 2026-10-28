/**
 * 找出 Chrome / Chromium 執行檔。
 *
 * 原本兩支工具裡都硬編碼 macOS 的路徑：
 *   /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
 * 在本機能跑，但 CI（Linux runner）或 Windows 上會直接失敗 ——
 * 而且是「找不到瀏覽器」這種看起來像環境問題、卻擋住整條驗證線的錯。
 *
 * 這裡依序找常見位置，也可以用 CHROME_PATH 環境變數指定。
 */
import fs from "node:fs";

const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  // Linux（GitHub Actions runner 內建 Chrome）
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  // Windows
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

export function findChrome() {
  for (const c of CANDIDATES) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

export function requireChrome() {
  const c = findChrome();
  if (c) return c;
  console.error("\n找不到 Chrome / Chromium。");
  console.error("裝一個，或用環境變數指定路徑：");
  console.error("  CHROME_PATH=/path/to/chrome node tools/visual-check.mjs\n");
  console.error("GitHub Actions 的 ubuntu-latest 內建 /usr/bin/google-chrome，不用另外裝。\n");
  process.exit(2);
}
