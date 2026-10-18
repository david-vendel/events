# events — what's on in Slovakia

A crawler that collects events in Slovakia (it started in Košice) and a small website that lists them
and shows them on a map. Events outside Slovakia are not kept; see *Only Slovakia* below.

## Run

Requires Node 18+.

```sh
npm install
claude                         # log in to Claude Code once, if you haven't (AI uses it)
npm run serve                  # website on http://localhost:3000, admin on /admin/
npm run dev                    # same, but restarts the server when its code changes
```

`npm run dev` uses `node --watch`. It restarts when `server.js` or a file it imports in `src/`
changes. A restart stops a crawl that is running. Files in `public/` are read on every request,
so after you edit them you only need to reload the page. Changes to `data/` never cause a restart.

There are two pages. `/` is the public website: the events, as a list or a map. `/admin/` is the
admin dashboard. Its **right** half is the same events list, and its **left** half is the admin panel
that controls the crawler, which runs inside the server:

- **Run / Stop.** **Run** crawls continuously, for the town picked in the events list (or all towns),
  until **Stop**, which lets the pages being fetched finish. There are no cycles to schedule. A Run pauses
  by itself, and carries on by itself, while that town's coverage is at the goal (Settings, default 90 %)
  or the Claude plan's 5-hour or weekly use is over its slider (both checked every 30 minutes), while
  there's nothing to crawl (every 5 minutes), and while offline (every minute). A Run that was going
  when the server restarts carries on after the restart (`state.meta.run`).
- **Parallel pages** (1–20, or up to 50 in Settings). A new value applies within a second. Each
  site still gets at most one request every 2 seconds.
- **Status:** the current step or why the Run is paused,
  a **health box** with the Run's totals (pages read, how many had upcoming events, new events, fetch
  errors, AI calls, links from sitemaps; crawler bugs in red with the error), the pages being fetched
  right now, recently scanned pages and what was found on them, and a log (a message repeated many times shows once, "×N").
- **Tabs:** *Queue* (links waiting to be explored, ranked as the crawler picks them, with what it
  learned), *Templates* (page templates that find events, and ones that waste visits; see below),
  *Sources* (sites the crawler has judged, their listing pages and whether a recipe is saved),
  *Domains*, *AI usage* (every AI call with tokens, cost and duration; click one to see what it
  returned), and *Settings*.

The admin API has no login, so the server listens only on localhost unless you set
`HOST=0.0.0.0`. To put it on the internet, use a proxy that leaves only the public page's files and
`GET /api/events`, `GET /api/sites` and `GET /towns.json` open and asks for a password for `/admin/` and every other
`/api/` route. Those two public answers are rebuilt at most every 30 seconds. `node server.js --start`
starts a Run for all towns right away.

Without the server: `npm run crawl` runs one pass through the steps below in the terminal and
`npm run watch` keeps crawling until Ctrl+C. Options: `--pages 200 --ai 30 --verify 15 --concurrency 5`, plus
`--url <url>` to crawl a page right away. Don't run the CLI while the server is crawling, because
both write the same files in `data/`.

## How it works

A Run goes through these steps over and over, without a break ([src/crawler.js](src/crawler.js)
does one pass; [src/engine.js](src/engine.js) repeats them). A pass explores up to 200 pages and makes up
to 30 AI calls, so every step keeps getting its turn; AI use overall is held back by the plan limits:

1. **Re-check known sources that are due.** Every website that publishes events in Slovakia is saved in
   `data/sources.json` with its listing pages and a check interval (12 h to 7 days). The interval
   shrinks when a source keeps producing new events and grows when it doesn't. Re-checks use
   conditional GETs (ETag/Last-Modified) and a hash of the page text, so pages that haven't changed
   are skipped without parsing.
2. **Verify against other sources.** For up to 15 upcoming events per pass (`--verify N`),
   soonest first, each event is re-checked at most every 3 days. The crawler opens the event's own
   page, follows its links to the same event elsewhere (Facebook events, ticket shops) and records
   the date each source gives. See "One event, many sources" below.
3. **Discovery** (every 6 hours, `EVENTS_DISCOVERY_HOURS`; AI only). Claude runs a web search for
   one kind of event in one Slovak town or region (a different pair each time) and the URLs it finds
   are added to the frontier. Every Slovak town (166) takes part, the biggest gaps in the biggest towns
   (by population) first ([src/coverage.js](src/coverage.js)). Besides, every pass queues the websites
   of 15 more Slovak municipalities (from `src/sk-places.json`, biggest first), until each of the
   ~2,850 has been visited once; most have a calendar of events.
4. **Sitemaps** ([src/sitemaps.js](src/sitemaps.js)). For sites that have produced events (and the
   seeds), the sitemap (from `robots.txt`, or `/sitemap.xml`) is read at most once a day; event-like
   pages and pages whose template has produced events are queued, newest first, at most 150 per site.
   This finds event pages that no listing links to (GoOut's sitemap alone lists ~27,000). Sites whose
   events are abroad have theirs read weekly, for only the pages whose address names Slovakia or a
   Slovak town.
5. **Explore.** Links from every visited page go into `data/frontier.json` with a score from the
   link itself: event words, Slovak towns (any of them, in any form: "v-trencine", "bratislavske"; and
   their Hungarian or German names), `.sk`, and penalties for news and discussion pages,
   archives, past years or dates in the URL ("rok=2009", "podujatia-2023") and other-language copies
   (`/pl/`, `/en/`, `?lang=hu`). Links to pages of events we already have are skipped (verification
   re-reads those), and on a listing with events, "next page" links get a bonus. When picking, what
   the crawler has **learned** is added (see *Page templates*), plus random noise, so promising links
   usually win but anything can be picked. Sites that produce many new events may take up to 15
   pages a pass, sites that produce some 8, unknown ones 3, and sites read 6+ times without any
   event 1.

### Page templates: learning where events are

Pages of one site built from one template share a URL shape ([src/urls.js](src/urls.js)):
`kamdomesta.sk/kosice/*`, `kosicak.sk/clanky/#/*`, `sfk.sk/sk/podujatia/*?page`. Numbers become `#`,
dates `D`, slugs `*`; short words stay. A rougher shape (host, first segment, depth) covers sites
whose ids look like words. For every template, `data/patterns.json` counts visits, visits that found
**upcoming** events (a page of past events is an archive, not a source) and new events
([src/learn.js](src/learn.js)). That is used three ways:

- **Ranking.** A link from a template that nearly always has new events gets up to +8, one visited
  often without any event down to −6; the site's record adds +2 … −5. A template whose events we
  already had (detail pages of events a listing gave us) gets at most +1. The Queue tab shows this
  as "Learned".
- **One AI call per template, not per page.** The AI looks at a template at most once a week, and not
  at all at a template visited 5 times without an event (seeds and listing pages it named are
  exempt). A recipe it writes is stored on the template and used for every page built from it, also
  detail pages: the AI is asked for a recipe even for a page with a single event.
- **Sibling recipes.** A template without a recipe tries the recipes of the same site's templates at
  the same depth, so `kamdomesta.sk/bratislava/koncerty` is read with the recipe written for
  `kamdomesta.sk/kosice/koncerty`, with no AI. A recipe that works is kept for the new template.

The first time this runs, the templates are filled from the pages already visited.

### Getting events out of a page

Three methods, tried from cheapest to most expensive:

- **schema.org JSON-LD** `Event` data, when the site has it. Free and exact.
- **A learned recipe**: CSS selectors for the event item, title, date, time, location and link,
  saved per listing page. Applying a recipe costs no AI tokens.
- **AI** ([src/ai.js](src/ai.js)), called only for a page that looks like an event listing (many
  dates, event words, mentions of Košice) and has no working recipe. Claude gets a stripped-down
  version of the HTML and returns what the site is, whether it publishes events, which country they are in, other
  listing pages on the same site, how often to check it, and a recipe. The recipe is tested on the
  page right away and saved only if it finds events. If a saved recipe later finds nothing, the
  site has probably been redesigned and the page is re-learned. Each page (and each page
  template) is shown to the AI at most once a week.

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
4. events still without a tag go to the cheap model, up to 2 × 40 per pass, each event once.

The website has a checkbox per tag; an event is shown if any of its tags is checked.

**Location.** Each event's location text is split into venue, street, postcode, town and district
([src/geo.js](src/geo.js)). A list of Slovak towns finds the town whatever the order ("Košice-Staré
Mesto, Collosseum klub", "Dom umenia Košice"); names that are also words or first names (sála, Svit,
Martin) count only on their own. A list of towns ("Košice, Prešov, Poprad", a tour) has no single
place and isn't put on the map. A missing town comes from the source site's city when the AI said
all its events are in one. Each distinct place is looked up once in OpenStreetMap's Nominatim geocoder
(street address, then venue name, then the whole text, then the town; at most 1 request per second
and 40 new places per pass; after "too many requests" lookups pause for an hour). A venue-name hit
must share a word with the venue's name and lie in the expected town, otherwise free-text search
would happily return the railway station called "Košice" for "Yama Event Place, Košice"; asking for
just the town always counts as town-level precision and cached in
`data/venues.json`. Coordinates on the event page itself (schema.org `geo`) win over the lookup.
Events with no location at all get a city from the AI tagging job when the title or page makes it
clear. Every upcoming event gets `place: { lat, lon, precision, name, address, km }`: `precision` is
`page`, `address`, `venue`, `city` (OpenStreetMap only matched a town or district) or `manual`, and
`km` is the distance from Košice. To fix a place by hand, edit its entry in `data/venues.json` and set
`"status": "manual"`. `EVENTS_GEOCODER=off` disables lookups.

The towns come from a list of every Slovak municipality with its centre, population, district,
website and names in other languages (`src/sk-places.json`, 2,925 places from Wikidata, including the
boroughs of Bratislava and Košice),
and the country's outline (`src/sk-border.json`, from OpenStreetMap); `node scripts/build-geo.js`
rebuilds both. A location that is just a Slovak town or village needs no lookup (its centre comes from
the list), and a borough on its own counts as its city ("Petržalka" → Bratislava, Petržalka). A Slovak
town named in the location beats coordinates more than 30 km from it (a same-named village in Bohemia,
a ticket page giving its organiser's address); such a venue is looked up again. A place whose town
isn't known is looked for in Slovakia first, then anywhere (which tells us it's abroad).

A town's Hungarian, German, Polish or Czech name counts as the town ("Ifjúsági Ház, Kassa" → Košice,
"Pressburg", "Érsekújvár" → Nové Zámky), as a whole part of the location only, and only towns' names
of 5+ letters that name one town and no place abroad: not villages' (German "Schönau" is Šuňava, and a
dozen villages in Germany), nor "Komárom" (Komárno's, and the Hungarian town across the river), nor a
short list of names common elsewhere (Rosenberg, Königsberg, Leopoldstadt…; `ALIAS_DENY`).

### Only Slovakia

On 17 Oct 2026 about 60 % of upcoming events were abroad (Hamburg, Prague, Nashville, Singapore…):
international ticket shops (songkick, eventbrite.\*, ticketscharf.de, smsticket.cz) had been learned as
good sources. Now only events in Slovakia are kept ([src/slovakia.js](src/slovakia.js),
`eventCountry` in [src/geo.js](src/geo.js)). Whether an event is in Slovakia comes from, best first:

1. its location's own words: a Slovak town or village it names, another country ("…, Czechia",
   "Zlín (CZ)"), a town abroad as a whole part ("…, Hamburg"), letters Slovak doesn't have (Czech
   ě ř ů, German ß…) or street words of other languages ("Fraser Highway", "Rue …"). A Slovak village
   alone, on pages whose events are abroad, is taken for the Czech one of that name (Dolany, Lipník…);
2. coordinates from the event's page or its venue's lookup, tested against the country's outline;
3. the location's language: letters or venue words only Slovak has ("Dom kultúry Kanianka",
   "Evanjelický kostol", "Hlavné námestie"), or a Slovak town in the locative ("Divadlo J. Palárika
   v Trnave", "knižnica v Tvrdošovciach");
4. the country the AI gave, a country code in the title ("LEVICE (SK)", "CZ TOUR"), the listing's
   address ("eventbrite.com/d/united-kingdom/…", "ticketportal.sk/venue/Kino-Hviezda-Trencin"; that it
   names Slovakia counts on a site abroad only for an event without a location: eventbrite's
   `/d/slovakia--trnava/` lists Vienna too), the city of its listing page or site, or its venue's;
5. last, its site: an event without a location on a `.sk` site, or on pages whose events are in
   Slovakia, is there; Czech words in the title or description ("Městské divadlo") on a site not known
   to have its events in Slovakia mean abroad. Otherwise it's not known until it's located.

The crawler learns **where each kind of page has its events**: every page template and every host
counts the events it gave that are known to be in Slovakia (`sk`) and abroad (`abroad`) in
`patterns.json` and `hosts.json`. With 3 or more known, a template or host is *Slovakia* (over 85 % in
Slovakia), *abroad* (under 15 %) or *mixed*; the exact template's verdict counts first, then the
rougher template's, then the host's (`regionAt` in [src/learn.js](src/learn.js)). Before all of
them, a page of a site outside `.sk` whose address names a country or a town abroad is that
(`eventbrite.com/d/australia--byron-bay/networking`, `…/festivals/berlin`). A site that has never had
an event in Slovakia and is on another country's domain (`kinoaero.cz`) or has had any event abroad
counts as abroad too, before it has 3 (`siteAbroad`). Then:

- events known to be abroad are dropped as they're read, and so are events whose place isn't known yet
  from pages whose events are abroad, or from a site abroad. Others whose place isn't known are kept and
  located later;
- links to pages whose events are abroad are never queued (and leave the queue), their sites' sitemaps
  give only their Slovak pages, the AI isn't shown them, and listing pages whose events were all abroad aren't re-checked.
  A site whose events are abroad stops being a source (every pass checks this for all sources). Mixed
  sites (eventbrite.com has Slovak events too) are judged template by template;
- but a site abroad may have Slovak pages, and is never written off for good:
  - a link to a page abroad with the place in its address (`eventbrite.com/d/germany--hamburg/
    networking`, `stayhappening.com/chicago`) queues the same page for the 8 biggest Slovak towns instead
    (`…/d/slovakia--bratislava/networking`, `stayhappening.com/kosice`), once a month per template
    (`slovakVariants`); such pages are explored even on a site whose events are abroad;
  - a retired site gets a look every 45 days: its 3 listing pages that had the most events, read with
    their saved recipes (no AI). An artist's tour or a ticket shop abroad may list a date in Bratislava;
    a page with events in Slovakia makes the site a source again;
- link scores drop for other countries' domains (`.cz`, `.de`…) and for URLs naming another country or a
  big town abroad;
- the page reader (AI) says which country a page's and its site's events are in; its word that they're
  abroad counts as three events seen there. The pre-check turns down pages whose events are all abroad;
- every pass, events already known to be abroad are dropped before locating (so no lookup is spent on
  them), and those found abroad by locating are dropped after, counted against their page's template
  and host.

**Is it leaking?** The admin Overview shows, for the Run, the pages read whose events were all abroad
(share of pages read, and the AI spent on them), events read abroad and not kept, and events dropped
later; and the upcoming events whose country isn't known yet, with a random sample to look over.

The AI's city for a listing page is kept per page; it's the whole site's city only while every page the
AI read names the same one. (It used to be the site's after one page: eventbrite.com became a "Trnava"
site and its London events were put in Trnava.) The Templates and Domains tabs tag each template and
site *Slovakia*, *abroad* or *mixed* (hover for the counts). The first pass with this code counts every
stored event towards its pages' templates and hosts, drops the city of 49 multi-city sites, and drops
~23,000 events abroad.

### The website: list and map

The website lists upcoming events by day, or shows them on a **map** (List / Map at the top;
`?view=map` opens the map directly). Both use the same filters: dates, search, **town** and kind of event.
Picking a town shows its events **and those within 25 km of it** (by the event's coordinates, or its
town's centre; `RADIUS_KM` in [public/events.js](public/events.js)). The list offers the towns that
have events of their own, most first, each with the number picking it shows ("Pezinok +25 km (1 564)"
includes Bratislava). Town centres come from `towns.json` (every Slovak town, and the villages events
are in), served outside `api/` so a proxy that guards `api/` leaves it public. The map ([public/events.js](public/events.js)) uses
[Leaflet](https://leafletjs.com) with OpenStreetMap tiles, loaded only when the map is opened. Each
place gets one pin with its number of events; its popup lists them by date. A dashed pin means only
the town is known (the pin is at its centre). Pins cluster when zoomed out, showing the number of
events inside. Choosing a town zooms to it.

#### Remembered settings

**Every setting a visitor changes on the list or map page stays as they left it** until they change
it again: closing the page, coming back later from a bookmark or a plain `/events` link brings it
all back. They're kept in the browser's `localStorage` (no login, nothing on the server):

| Setting | localStorage key | Can a link set it? |
| --- | --- | --- |
| List or Map | `view` | `?view=map` |
| Town | `city` (also written into the address bar) | `?city=Košice` |
| Dates (Today / Weekend / 7 days / All) | `range` | |
| Search text | `q` | |
| Unchecked kinds of event | `hiddenTags` | |
| Where the map was (centre, zoom) | `mapAt` | |

A value in the link wins over the remembered one and is remembered from then on.

**Adding a setting or control to the page? Remember it too**: read it with `recall` when the page
loads, show it, and save it with `remember` whenever it changes (top of
[public/events.js](public/events.js)), then add a row to this table.

### When things go wrong

- **A bug in the crawler** (an exception while reading a page) no longer looks like "no events
  here": it's counted in the health box, shown in red with the error, the visit is forgotten so the
  page is read again once it's fixed, and after 10 bugs with fewer pages read the Run pauses for 30
  minutes instead of burning the queue. (On 2 Oct 2026 a refactor left `MONTH_RE` undefined in
  `extract.js` and every page failed for 4 hours, silently; 3,760 pages were repaired.)
- **No network** (laptop asleep, Wi-Fi gone): a series of network errors triggers a check; when
  DNS lookups fail, the Run pauses (looking again every minute) and those failed visits are forgotten, so pages and sites aren't marked as failing.

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
that used it (click the tag to open that call). In a Run, AI use is held back by the
5-hour and weekly sliders under the Run button (default 80 % of the plan each); `--ai N` caps calls per
pass on the command line (default 30).

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
| `patterns.json` | page templates: visits, visits with events, new events, events in Slovakia / abroad, AI verdict, shared recipe |
| `sitemaps.json` | per site: when its sitemap was last read and what it gave |
| `hosts.json` | per host: visits, errors, events, new events, events in Slovakia / abroad (site-level learning, failure pauses) |
| `ai.json` | every AI call: model, tokens, cost, duration, what it returned |
| `settings.json` | crawler settings from the admin panel |

The crawler identifies itself as `KosiceEventsBot`, follows `robots.txt` and waits 2 seconds between
requests to the same host.

## Not done yet

- Discovering events that exist only on social networks. Facebook events are read only when a website
  links to them (and only with `EVENTS_FACEBOOK=on`). Other social links are collected in
  `data/social.json`.
- Sites that render events only with JavaScript need a headless browser.
- Pagination is followed through "next page" links and learned templates, not read in one go.
