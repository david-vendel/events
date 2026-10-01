#!/usr/bin/env node
// Crawl a single page: fetch it and print title, description, headings and links.
import * as cheerio from 'cheerio';

let url = process.argv[2];
if (!url) {
  console.error('Usage: node crawl.js <url>');
  process.exit(1);
}
// Default to https when no scheme is given (e.g. "www.google.com").
if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url)) url = `https://${url}`;

const res = await fetch(url, { headers: { 'User-Agent': 'events-crawler/0.1' } });
if (!res.ok) {
  console.error(`Request failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const $ = cheerio.load(await res.text());
const clean = (s) => s.replace(/\s+/g, ' ').trim();

console.log(`URL:         ${res.url}`);
console.log(`Status:      ${res.status}`);
console.log(`Title:       ${clean($('title').first().text()) || '(none)'}`);
console.log(`Description: ${$('meta[name="description"]').attr('content') || '(none)'}`);

console.log('\nHeadings:');
$('h1, h2, h3').each((_, el) => {
  const text = clean($(el).text());
  if (text) console.log(`  ${el.tagName.toUpperCase()}  ${text}`);
});

const links = new Map();
$('a[href]').each((_, el) => {
  try {
    const href = new URL($(el).attr('href'), res.url).href;
    if (href.startsWith('http') && !links.has(href)) links.set(href, clean($(el).text()));
  } catch {}
});
console.log(`\nLinks (${links.size}):`);
for (const [href, text] of links) console.log(`  ${text || '(no text)'} -> ${href}`);
