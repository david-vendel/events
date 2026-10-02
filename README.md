# events — what's on in Košice

A crawler that looks for events happening in Košice, Slovakia, and a small website that lists them.

## Run

Requires Node 18+.

```sh
npm install
claude                         # log in to Claude Code once, if you haven't (AI uses it)
npm run serve                  # website + admin panel on http://localhost:3000
npm run dev                    # same, but restarts the server when its code changes
```

`npm run dev` uses `node --watch`. It restarts when `server.js` or a file it imports in `src/`
changes. A restart stops a crawl that is running. Files in `public/` are read on every request,
so after you edit them you only need to reload the page. Changes to `data/` never cause a restart.

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

**Dates** ([src/dates.js](src/dates.js)) are parsed from Slovak formats such as `03.10.2026`,
`9. – 11. októbra`, `piatok 3. októbra o 18.00 h`, `02.10.2026 10:00 - 03.10.2026 18:00` and ISO dates,
into a first and last day and a start and end time. Placeholder times are dropped (`00:00` = all day,
`23:59` = open end, an end at `00:00` = the day before). The built-in parser is checked by AI, so
it can't stay wrong for long:

1. Every date text from a listing is reduced to a *shape* (`N.N.Y N:N - N.N.Y N:N`) and remembered in
   `data/dateFormats.json` with a few samples.
2. A new shape goes to the **Check dates** AI job (cheap model, up to 12 formats per call). Shapes
   where the parser looks unsure (more dates or times in the text than it read, a weekday schedule,
   no date found) go first. AI says what each sample means and writes a regex rule for the format.
3. If the parser agrees, the format is confirmed. If not, AI's rule is saved when it reproduces
   AI's own answers, and that format is read with the rule from then on, with no AI. When no rule
   works, AI's answers are used for the exact texts it saw, and it's asked again the next day.
   Stored events in a format whose reading changed are read again right away.
4. Every format is **re-checked** with its newest samples every 14 days. A disagreement drops the
   rule and the format is learned again.

A schedule written as sentences on the event's detail page ("v piatok od 10.00 do 17.00 … v sobotu
od 10.00 do 18.00") is spotted while the event is verified and read by the same AI job into a per-day
schedule, so the website shows each day's own hours. When the date parser changes,
`PARSER_VERSION` is bumped so listing pages are read again even if they haven't changed.

Events that come from national or multi-city listings are kept only if they mention Košice.

Every event gets **tags** for its kind (cinema, concert, theatre, exhibition, festival, kids, sport,
workshop, talk, party, market; see [src/tags.js](src/tags.js)). Rules come first, and AI is used only
when they fail:

1. schema.org types (`ScreeningEvent` → cinema), and the listing page's heading ("Program kina…") or
   the page AI's verdict for the whole page;
2. keyword rules on the title, venue and URL (film screenings keep only `cinema`, plus `kids`/`festival`);
3. **learned rules**: each event the AI tagging job (Haiku by default) tags is counted
   per venue, listing page and title word in `data/tagRules.json`. Once a venue has 2 AI-tagged events
   with the same tag (80 % agreeing), a listing page 3, or a title word 4 (90 %), that tag is applied
   without AI, but only to events the page and keyword rules left untagged. The log says
   "Learned tag rule: …" when one becomes active;
4. events still without a tag go to the cheap model, up to 2 × 40 per cycle, each event once.

The website has a checkbox per tag; an event is shown if any of its tags is checked.

**Location.** Events from any place are kept (the project started with Košice, and link priorities
still favour it). Each event's location text is split into venue, street, postcode and city
([src/geo.js](src/geo.js)); a missing city comes from the source site's city when the AI said all its
events are in one. Each distinct place is looked up once in OpenStreetMap's Nominatim geocoder
(street address, then venue name, then the whole text or city; at most 1 request per second and 40
new places per cycle; after "too many requests" lookups pause for an hour) and cached in
`data/venues.json`. Coordinates on the event page itself (schema.org `geo`) win over the lookup.
Events with no location at all get a city from the AI tagging job when the title or page makes it
clear. Every upcoming event gets `place: { lat, lon, precision, name, address, km }`: `precision` is
`page`, `address`, `venue`, `city` (OpenStreetMap only matched a town or district) or `manual`, and
`km` is the distance from Košice. To fix a place by hand, edit its entry in `data/venues.json` and set
`"status": "manual"`. `EVENTS_GEOCODER=off` disables lookups.

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
calls per cycle (default 5).

The **AI tab** controls AI and shows what it was used for. A master switch turns all AI off (the
crawler then runs on rules only), and each job has its own switch and model (your Claude Code default,
haiku, sonnet or opus):

- **Read new listing pages**: what the site is, plus a recipe so later visits need no AI (default model).
- **Tag & locate events**: kinds for events the rules couldn't tag, and a city for events with no location; tags become rules (haiku).
- **Find new sources**: web search for new event pages, at most daily (default model).
- **Check dates**: confirms date formats and writes rules for them, re-checks them every 14 days, and reads schedules written as prose (haiku).

Changes are saved in `data/settings.json` and apply from the next AI call, also for `npm run crawl`.

At the top of the tab is **your Claude plan**, read the same way as Claude Code's `/usage`: plan type,
% used of the 5-hour and weekly windows, and usage credits for the month. It's the account your
Claude Code is logged in with, shared with your own Claude Code use. Plans have no token allowance;
**API price** (per call, job and model) is what the same tokens would cost on the pay-per-token API,
which is useful for comparing models. Click a call to see what the AI figured out in plain words, what
the crawler did with it, and the exact input and raw answer (inputs of the last 300 calls are kept in
`data/ai-inputs/`).
Below the switches is every call: its job, model, tokens, and *what came of it* ("recipe saved,
finds 19 events", "Digger → cinema", "12 links queued"). On the website, a tag the AI gave is
marked "· AI", and one from a rule learned from AI answers "· learned". `EVENTS_AI=off` only sets the
starting state before anything is saved in the panel.

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
| `dateFormats.json` | date text shapes: samples, how each is read (built-in / AI rule), last AI check |
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
