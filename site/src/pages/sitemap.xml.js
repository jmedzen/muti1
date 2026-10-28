/**
 * sitemap — /sitemap.xml
 *
 * 由實際建置出的路由清單產生，不靠人工維護。
 * lastmod 用資料本身的時間（文章發佈日、年譜年份），不是 build 時間 ——
 * 每次都回 build 時間會讓搜尋引擎覺得整站天天在改，反而降低可信度。
 */
import { SITE, articles, artistArticles, galleries, CATEGORIES } from "../lib/content.js";

export async function GET({ site }) {
  const base = (site?.toString() || SITE.url).replace(/\/$/, "");

  const newest = articles
    .map((a) => a.publishedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const siteLastmod = newest ? newest.slice(0, 10) : new Date().toISOString().slice(0, 10);

  const entry = (loc, lastmod, changefreq, priority) =>
    `  <url>
    <loc>${base}${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;

  const urls = [];

  // 主要頁面
  urls.push(entry("/", siteLastmod, "weekly", "1.0"));
  urls.push(entry("/about", siteLastmod, "monthly", "0.9"));
  urls.push(entry("/about/chronology", siteLastmod, "yearly", "0.8"));
  urls.push(entry("/about/painting-view", siteLastmod, "yearly", "0.7"));
  urls.push(entry("/collection", siteLastmod, "monthly", "0.9"));
  urls.push(entry("/collection/years", siteLastmod, "monthly", "0.7"));
  urls.push(entry("/life", siteLastmod, "monthly", "0.7"));
  urls.push(entry("/news", siteLastmod, "weekly", "0.9"));
  urls.push(entry("/art-reviews", siteLastmod, "monthly", "0.8"));
  urls.push(entry("/archive", siteLastmod, "monthly", "0.6"));
  urls.push(entry("/contact", siteLastmod, "yearly", "0.5"));

  // 作品集
  for (const g of galleries) {
    urls.push(entry(g.route, siteLastmod, "monthly", g.counts.artwork > 0 ? "0.8" : "0.6"));
  }

  // 分類（用 CATEGORIES 的實際 route，不要自己拼 slug）
  for (const c of CATEGORIES.filter((x) => ["memorial", "exhibition", "auction", "media", "official"].includes(x.id))) {
    urls.push(entry(c.route, siteLastmod, "monthly", "0.6"));
  }

  // 文章（新聞 + 評論）：lastmod 用發佈日
  for (const a of articles) {
    urls.push(entry(a.route, (a.publishedAt || siteLastmod).slice(0, 10), "yearly", "0.6"));
  }
  for (const a of artistArticles) {
    urls.push(entry(a.route, (a.publishedAt || siteLastmod).slice(0, 10), "yearly", "0.5"));
  }

  // 去重（萬一同一路徑出現兩次）
  const seen = new Set();
  const unique = urls.filter((u) => {
    const loc = /<loc>([^<]+)<\/loc>/.exec(u)[1];
    if (seen.has(loc)) return false;
    seen.add(loc);
    return true;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${unique.join("\n")}
</urlset>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
