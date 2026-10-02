// Render a page in headless Chrome and return the resulting HTML, for pages that load their
// content with JavaScript (Facebook events). Uses the locally installed Chrome; no npm dependency.
// Chrome identifies itself as "HeadlessChrome" in its user agent.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const CANDIDATES = [
  process.env.EVENTS_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export const chromePath = () => CANDIDATES.find((p) => fs.existsSync(p));

/** @returns {Promise<string|null>} rendered HTML, or null when Chrome is missing or fails */
export function renderPage(url, { waitMs = 8000 } = {}) {
  const chrome = chromePath();
  if (!chrome) return Promise.resolve(null);
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--lang=sk',
    `--virtual-time-budget=${waitMs}`, '--dump-dom', url];
  return new Promise((resolve) => {
    execFile(chrome, args, { timeout: waitMs + 30000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}
