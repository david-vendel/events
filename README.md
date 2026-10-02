# events — what's on in Košice

A crawler that looks for events happening in Košice, Slovakia, and a small website that lists them.

## Run

Requires Node 18+.

```sh
npm install
claude                         # log in to Claude Code once, if you haven't (AI uses it)
npm run serve                  # website + admin panel on http://localhost:3000
```

The page has two halves. The **right** half lists the events. The **left** half is the admin panel
that controls the crawler, which runs inside the server:

- **Start / Run once / Stop.** Start repeats cycles every *N* minutes (see Settings). Stop lets the
  pages that are being fetched finish, then stops.
- **Parallel pages** (1–20, or up to 50 in Settings). A new value applies within a second. Each
  site still gets at most one request every 2 seconds.
- **Status:** the current phase, progress bars for the cycle's page, AI and verification budgets,
  the pages being fetched right now, recently scanned pages and what was found on them, and a log.
- **Tabs:** *Queue* (links waiting to be explored, by score), *Sources* (sites the crawler has judged,
  their listing pages and whether a recipe is saved), *AI usage* (every AI call with tokens, cost and
  duration; click one to see what it returned), and *Settings*.

The admin API has no login, so the server listens only on localhost unless you set
`HOST=0.0.0.0`. Add authentication before you put it on the internet. `node server.js --start`
starts crawling right away.

Without the server: `npm run crawl` runs one cycle in the terminal and `npm run watch` keeps
running cycles. Options: `--pages 100 --ai 10 --verify 15 --concurrency 5 --every 30`, plus
`--url <url>` to crawl a page right away. Don't run the CLI while the server is crawling, because
both write the same files in `data/`.

## How it works

Each cycle has three steps ([src/crawler.js](src/crawler.js)):

1. **Re-check known sources that are due.** Every website that publishes Košice events is saved in
   `data/sources.json` with its listing pages and a check interval (12 h to 7 days). The interval
   shrinks when a source keeps producing new events and grows when it doesn't. Re-checks use
   conditional GETs (ETag/Last-Modified) and a hash of the page text, so pages that haven't changed
   are skipped without parsing.
2. **Verify against other sources.** For up to 15 upcoming events per cycle (`--verify N`),
   soonest first, each event is re-checked at most every 3 days. The crawler opens the event's own
   page, follows its links to the same event elsewhere (Facebook events, ticket shops) and records
   the date each source gives. See "One event, many sources" below.
3. **Discovery** (at most once a day, AI only). Claude runs a web search with a randomly chosen
   query (markets, concerts, kids' events…) and the URLs it finds are added to the frontier.
4. **Explore.** Links from every visited page go into `data/frontier.json` with a score. Links that
   look like events or mention Košice score higher, `.sk` domains get a small bonus, and links to
   sites already judged irrelevant score lower. Each cycle picks frontier links by score plus random
   noise, so promising links usually win but anything can be picked. Each host gets at most 3
   exploration visits per cycle.

### Getting events out of a page

Three methods, tried from cheapest to most expensive:

- **schema.org JSON-LD** `Event` data, when the site has it. Free and exact.
- **A learned recipe**: CSS selectors for the event item, title, date, time, location and link,
  saved per listing page. Applying a recipe costs no AI tokens.
- **AI** ([src/ai.js](src/ai.js)), called only for a page that looks like an event listing (many
  dates, event words, mentions of Košice) and has no working recipe. Claude gets a stripped-down
  version of the HTML and returns what the site is, whether it publishes Košice events, other
  listing pages on the same site, how often to check it, and a recipe. The recipe is tested on the
  page right away and saved only if it finds events. If a saved recipe later finds nothing, the
  site has probably been redesigned and the page is re-learned. Each page is re-learned at most
  once a week.

Dates are parsed from Slovak formats such as `03.10.2026`, `9. – 11. októbra`, `piatok 3. októbra o 18.00 h`
and ISO dates. Events that come from national or multi-city listings are kept only if they mention Košice.

### One event, many sources

Every event keeps a list of sources ([src/events.js](src/events.js)). The first is the primary
source, for example `vsg.sk/event/…`. Other sources are the Facebook event or ticket page it links
to, or another site that lists the same event. Each source keeps its own date, and the website
shows them in a table under the event. A date is green when it matches the primary source and red
when it doesn't.

The crawler decides that two sightings are the same event when ([src/match.js](src/match.js)):

- they share a page, for example the same Facebook event (`fb.me` short links are resolved and
  tracking parameters removed). Two events that link to the same Facebook event are merged, even
  if their titles differ;
- their dates overlap and their titles share most meaningful words ("Biela noc" and "Biela Noc
  Košice 2026");
- their titles are nearly identical and their dates are at most 3 days apart. This is a real date
  disagreement and shows red.

Recurring events with the same title, like "every first Wednesday", are more than 3 days apart, so
they stay separate events.

**Facebook.** Facebook's `robots.txt` disallows all crawlers, and its terms forbid automated
collection without permission. Facebook links are therefore listed as sources marked "not checked".
To read their dates, run with `EVENTS_FACEBOOK=on`. The public event page is opened without
logging in. Facebook loads the time with JavaScript, so the page is rendered in your local headless
Chrome ([src/browser.js](src/browser.js)), which identifies itself as `HeadlessChrome`. The start
and end time come from the event's timestamps, and the date is checked against the page metadata.
Set `EVENTS_CHROME` if Chrome isn't in a standard location. Without Chrome only the date is read.

### AI

AI calls go through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), which uses
your **Claude Code login**. They count against your Claude subscription's usage limits, shared
with your own Claude Code use, and aren't billed per token. Log in once with `claude` and the
crawler can use AI. Each call is isolated: no Claude Code tools except WebSearch for discovery,
none of your settings, CLAUDE.md or hooks, and no saved session. `ANTHROPIC_API_KEY` is removed
from the environment for these calls so they can't be billed to an API account by accident.

AI calls run **one at a time**, never in parallel, even when the crawler fetches many pages at
once. Pages that need AI wait in line while the other workers keep crawling. The Overview shows
what the AI is doing right now, how many pages are waiting, and an "AI · N tokens" tag on each page
that used it (click the tag to open that call). `--ai N` (or *AI calls per cycle* in Settings) caps
calls per cycle (default 5). The *AI usage* tab
shows every call with its tokens and duration. Set `EVENTS_AI=off` to disable AI, and
`EVENTS_AI_MODEL` to choose a model (default: your Claude Code default model).

### Data

All state is JSON files in `data/` (gitignored). [src/store.js](src/store.js) is the only code that
reads or writes them, so moving to a database later means changing that one file.

| file | contents |
|---|---|
| `sources.json` | known websites: kind, summary, listing pages and their recipes, schedule, stats |
| `events.json` | events, each with its list of sources and the date each source gives |
| `frontier.json` | links waiting to be explored, with scores |
| `pages.json` | HTTP cache info per URL (ETag, Last-Modified, text hash) |
| `social.json` | Facebook/Instagram/etc. links found while crawling, saved for later |
| `ai.json` | every AI call: model, tokens, cost, duration, what it returned |
| `settings.json` | crawler settings from the admin panel |

The crawler identifies itself as `KosiceEventsBot`, follows `robots.txt` and waits 2 seconds between
requests to the same host.

## Not done yet

- Discovering events that exist only on social networks. Facebook events are read only when a website
  links to them (and only with `EVENTS_FACEBOOK=on`). Other social links are collected in
  `data/social.json`.
- Sites that render events only with JavaScript need a headless browser.
- Pagination on listing pages: only the first page of a listing is read.
