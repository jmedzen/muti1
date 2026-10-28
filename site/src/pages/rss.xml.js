/**
 * RSS — /rss.xml
 * 取最新 30 則文章，全文摘要放 description。
 */
import { articlesSorted, SITE } from "../lib/content.js";

const esc = (s = "") =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export async function GET({ site }) {
  const base = (site?.toString() || SITE.url).replace(/\/$/, "");
  const items = articlesSorted.slice(0, 30);

  const body = items
    .map((a) => {
      const d = new Date(a.publishedAt || Date.now());
      const desc = (a.bodyText || a.title).replace(/\s+/g, " ").slice(0, 400);
      return `    <item>
      <title>${esc(a.title)}</title>
      <link>${base}${a.route}</link>
      <guid isPermaLink="true">${base}${a.route}</guid>
      <pubDate>${isNaN(d) ? new Date().toUTCString() : d.toUTCString()}</pubDate>
      <category>${esc(a.categoryName)}</category>
      <description>${esc(desc)}</description>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(SITE.name)}</title>
    <link>${base}/</link>
    <description>${esc(SITE.description)}</description>
    <language>zh-Hant-TW</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${base}/rss.xml" rel="self" type="application/rss+xml" />
${body}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
