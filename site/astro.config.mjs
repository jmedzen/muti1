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
  },
});
