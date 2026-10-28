import { defineConfig } from "astro/config";

// 純靜態輸出：整個站 build 成一堆 HTML + 資產，交給 Cloudflare Workers 的
// Static Assets 直接從邊緣節點回，不需要任何 runtime 或資料庫。
export default defineConfig({
  site: "https://luisang.rumotan.com",
  output: "static",
  trailingSlash: "ignore",
  build: {
    format: "directory",
    inlineStylesheets: "auto",
  },
  compressHTML: true,
  vite: {
    build: {
      cssMinify: "lightningcss",
    },
    plugins: [
      // astro dev 不會把 public/ 底下的資料夾網址對應到 index.html，
      // /admin 與 /admin/ 會 404（建置後由 Cloudflare 處理，沒有這個問題）。
      // 只在開發伺服器把它轉成 /admin/index.html，讓後台在本機也打得開。
      {
        name: "admin-index",
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            if (req.url === "/admin" || req.url === "/admin/") req.url = "/admin/index.html";
            next();
          });
        },
      },
    ],
  },
});
