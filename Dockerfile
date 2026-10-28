# ─────────────────────────────────────────────────────────────────────────────
# 黃磊生美術館官網 — 多階段建置
#
# 為什麼是 nginx 而不是 wrangler：
#   Cloudflare Workers 的部署走 `wrangler deploy`，不需要容器。
#   但「打包成 docker」的需求是「在任何機器上起一個一模一樣的站」，
#   那用 nginx 服務靜態檔最單純、映像最小、啟動最快。
#   兩條路都保留：Dockerfile = 自架 / 預覽；wrangler.jsonc = Cloudflare。
#
# 只需要 site/ 目錄：
#   網站的所有資料（含 content/model.json 的正規化結果與處理好的 WebP）
#   都已經在 site/ 裡面了 —— site/src/data/ 與 site/public/media/。
#   不需要 content/、也不需要 raw/，所以映像裡不會有 55 MB 的原始 HTML。
# ─────────────────────────────────────────────────────────────────────────────

# ── 階段 1：建置 ──
FROM node:22-alpine AS build

WORKDIR /app

# 先只複製 manifest，讓 npm ci 這層能被快取
COPY site/package.json site/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# 複製網站原始碼（含已處理好的圖片，所以不需要 sharp 在容器裡跑）
COPY site/ ./

ENV ASTRO_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    CI=1

RUN npx astro build

# ── 階段 2：serve ──
FROM nginx:1.27-alpine AS runtime

RUN rm -f /etc/nginx/conf.d/default.conf
COPY docker/nginx.conf /etc/nginx/conf.d/luisang.conf
COPY --from=build /app/dist /usr/share/nginx/html

# 健康檢查：拿到首頁 200 才算活著
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

EXPOSE 80

# nginx 官方映像的 entrypoint 會處理訊號，不要覆寫
CMD ["nginx", "-g", "daemon off;"]
