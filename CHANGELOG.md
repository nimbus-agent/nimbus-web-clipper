# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are tag-driven (`vX.Y.Z`); see [README](./README.md#releasing) and `publish.yml`.

## [Unreleased]

### Changed

- **The three source-file lanes now actually run.** *What breaks if this
  changes*, *Who knows this file* and *Who owns this* shipped in 0.9.0 against
  `GET /v1/items/resolve-file`, a gateway route that did not exist anywhere —
  so on every gateway in the world the panel probed, got a 404, withheld the
  lanes and said nothing. The route landed upstream in Nimbus#1447 and ships in
  the release after gateway 7.9.0. **Nothing in the extension changed and no
  re-pairing is needed** — pair with a gateway carrying that release and the
  lanes appear on a GitHub, GitLab or Bitbucket file page.
  Your paired token does need the `resolve` scope. A browser paired before
  scopes existed carries only `clip` and `briefs`, and gets a scope refusal
  naming the fix: run `nimbus clip scopes` on the gateway to add `resolve` in
  place. That is still not a re-pairing.
  One bound worth knowing: the gateway can only resolve a checkout cloned from
  `github.com`, `gitlab.com` or `bitbucket.org` with an `owner/name` path. A
  self-hosted forge (GitHub Enterprise and friends) or a GitLab **subgroup**
  project answers "Nimbus has no local checkout of this repository" however the
  checkout is configured.

### Fixed

- **Linear's dashboard match keyed only on the second path segment, so any
  first segment satisfied it — including Linear's own published documentation
  pages.** `linear.app/docs/inbox` and `linear.app/docs/my-issues` are real
  Linear docs articles, not a workspace called "docs", but both were
  recognised as a workspace dashboard and shown the three connector-scoped
  agent lanes. The matcher now declines a fixed set of reserved first
  segments (`docs`, `settings`, `login`, and others no workspace can be
  named) before treating one as a workspace slug.
- **A dashboard for a connector Nimbus had no credential for still offered three
  agent lanes — and answered all three with nothing, which read as "you have no
  work" rather than "Nimbus isn't connected to this".** On a recognised product
  dashboard (a GitHub home page, Jira's "Your work"), *catch me up*, *what
  changed while I was away* and *what's mine* ran unconditionally, scoped to the
  whole connector, with no check that the connector could answer at all. The
  panel now reads the gateway's per-connector health before offering them: a
  healthy connector still gets its three lanes; a degraded, rate-limited or
  paused one keeps them with a caveat, and a sync time when the gateway
  supplied one; a connector that has never synced, whose credential was
  rejected, or whose last sync failed gets one honest sentence instead — and no
  lanes to answer nothing from. This needs a gateway that serves
  `GET /v1/connectors`; one that does not — a 404, or unreachable — leaves the
  panel exactly as it rendered before this change, silently, with no lanes
  withheld and nothing said about it.

### Added

- **Linear and CircleCI are now recognised.** Nimbus had nothing to say on
  either — a Linear issue or a CircleCI pipeline was just a tab, and their
  dashboards offered none of the three connector-scoped lanes GitHub's or
  Jira's already did. Both now resolve: an issue or a pipeline page gets its
  indexed item and Related, the same as any other recognised item page.
  Neither offers a targeted fetch on a miss — the gateway's fetch boundary
  covers GitHub, GitLab, Bitbucket, Jenkins and Jira only, so a miss on these
  products stays a miss. Open the connector's own dashboard instead —
  CircleCI's `/pipelines` or `/home`, a Linear workspace's Inbox or My Issues —
  and the panel offers *catch me up*, *what changed while I was away* and
  *what's mine*, gated on the connector's health exactly as every other
  dashboard's lanes are. An issue or pipeline page itself gets none of the
  three: they answer about the whole connector, not one item, so they stay
  where that scope is honest. CircleCI can be added as a self-hosted origin —
  CircleCI Server exists; Linear has no self-hosted edition, so it is not
  offered there.

- **Confluence pages and PagerDuty incidents are now recognised.** A Confluence
  page and a PagerDuty incident were each just a tab; both now get the panel's
  header, freshness, Related and the glossary lane, and a Confluence site's
  home or a PagerDuty incidents list gets *catch me up*, *what changed while I
  was away* and *what's mine*, gated on the connector's health like every other
  dashboard. Neither offers a targeted fetch on a miss: the gateway's fetch
  boundary covers GitHub, GitLab, Bitbucket, Jenkins and Jira only. The three
  connector-scoped lanes above do not run on the item page itself — they
  answer about a whole connector, not one document or one incident, and stay
  that way for both. (A PagerDuty incident later gained its own, item-scoped
  lanes — client-side; see the entry below for the gateway they wait on.)

  Confluence shares `*.atlassian.net` with Jira and is told apart by its `/wiki`
  path, so no new page-access grant is involved: granting either grants both,
  because a browser permission is per host — and revoking from either row now
  names the other on screen, rather than silently withdrawing page access from
  a product you did not touch. A self-hosted Confluence Data Center instance can
  be added from Options like any other self-hosted product.

  **A known gap, and it is the gateway's to close:** the gateway indexes a
  Confluence page under `…/wiki/pages/viewpage.action?pageId=<id>`, which is not
  a URL a browser is ever on, so a Confluence page reports *not indexed* even
  when Nimbus has it. Related still answers, because it matches on the title.
  Fixed upstream in [Nimbus#1364](https://github.com/nimbus-agent/Nimbus/pull/1364),
  which indexes the page under the `_links.webui` URL Confluence itself links
  to; this client deliberately does not work around it, because canonicalisation
  is the gateway's job.

- **A Jira issue, a Linear issue and a PagerDuty incident can now get agent
  lanes.** Recognition reached these products in the last two releases and
  then had nothing to run on them: an issue got a header, a freshness line,
  Related and the glossary box, and no lane at all. *How did we get here*,
  *who should I talk to* and *who owns this* now run there too, answered
  about the indexed item the page resolves to.

  **Needs gateway 7.7.0 or later.** Offering one of these three lanes needs
  the gateway to accept an item URL, and its agent list alone cannot say
  whether it does: all three agent *names* have been published since 7.5.0,
  their item *arms* since that same release — but nothing said which gateway
  you were running until 7.7.0 added a version to `GET /v1/agents`. Below
  7.7.0 (7.5.0 and 7.6.0 included) the gateway has the arm and cannot say what
  it is, so it fails closed and the three lanes stay withheld — a locally
  built gateway included, since a local build reports no version at all
  rather than `0.0.0`. At 7.7.0 or later they run, with no change to this
  extension and no re-pairing.

- **The panel no longer offers a lane the paired gateway cannot serve.** The
  lane list was a hardcoded assertion about a gateway you might not be
  running; an older one answered a lane by failing it. The panel now reads
  what the gateway publishes and offers that — which does work today, on every
  gateway serving `GET /v1/agents`. A gateway too old to answer the capability
  question at all is not second-guessed, and what that means depends on the
  page: on a pull request or a product dashboard nothing is withheld and the
  panel renders exactly as it did before. On an issue or an incident the three
  lanes above are withheld, because their arm is the one thing an unanswered
  capability read leaves unconfirmed — and withholding them puts those pages
  back to exactly what they showed before this release. Not offered and failing
  are different things, and only one of them is honest.

- **A source file on GitHub, GitLab or Bitbucket now gets three agent lanes.**
  A file page — `.../blob/<ref>/<path>`, or Bitbucket's `/src/` equivalent —
  was previously just a tab; opening the panel there now offers *what breaks
  if this changes*, *who knows this file* and *who owns this*, answered about
  the file resolved against the reader's own checkout. Branch names can
  contain slashes, so the client sends the ref and path together, unsplit, and
  the gateway disambiguates it against the repo's own file list.

  **A file Nimbus cannot place says which of two things is true, not one
  vague miss.** Either Nimbus has no local checkout of the repo at all, or it
  has the repo but not that file — different facts with different fixes, and
  the panel names the one that applies instead of a lane's worth of "not
  found" repeated three times.

  **You will not see this yet, and no gateway anywhere can show it to you.**
  Offering these lanes needs the gateway to resolve a forge file coordinate to
  a path, and that route — `GET /v1/items/resolve-file` — is proposed, not
  merged, not shipped anywhere upstream. Until it lands, opening a file page
  renders exactly as it did before this release — recognised, no lanes, no
  banner — for every user, silently, with nothing on screen to say the
  gateway is the reason. This entry describes a client that is finished and
  waiting.

- **`Who should review it` on a pull request now answers about the pull
  request itself, on a gateway that can take it.** It has always sent the
  PR's *title* to an agent that answers about topics — "who has touched things
  whose titles look like this" — which is not the question the lane's label
  promises, and was never switched because doing so unconditionally would
  have silently turned the lane off on every gateway that could not yet accept
  a PR address. It now sends the PR itself when the paired gateway is new
  enough to serve it, and falls back to the old title-based question when it
  is not — so the lane sharpens for gateways that can answer it and keeps
  working, exactly as it always has, for the ones that cannot.

## [0.5.0] - 2026-08-24

The release in which the clipper became a client. Alongside capture, the
extension now recognises the page you are on, resolves it to an item your
gateway has already indexed, runs your agents against it without a context
switch, answers questions across several open tabs, and shows you what your
gateway did on your behalf.

**Requires gateway 2.18.0 or later for everything here.** Older gateways are
supported and say so: each surface names what it cannot do rather than failing
silently or showing an empty result.

### Fixed

- **Two refusals of a page's canonical address said the wrong thing, and one
  put credentials in front of you.** When a page declared an insecure `http`
  address as the canonical form of its own `https` page, Nimbus refused it —
  correctly — but told you the page "asked to be saved under another site's
  address", when the site was identical. That refusal now says what actually
  happened. And a canonical address carrying a username and password
  (`https://user:pass@example.com/...`) was accepted as-is: the credentials
  went into the address the clip was filed under and were shown back to you in
  the pre-send preview. Such an address is now refused, and the clip is filed
  under the address bar instead.

- **The Activity page said every fetch was authorised, and never how it ended.**
  Your gateway records a fetch before it makes it — deliberately, so a fetch it
  cannot record is a fetch it does not make — which meant the page could only
  ever report that a fetch was *allowed*, not whether it found anything. It now
  shows the outcome beside each one: what was indexed, what was not found and
  why, what the provider rate-limited. Where no outcome was recorded it says
  exactly that, and never that a fetch is still running — a gateway older than
  the change leaves rows indistinguishable from ones whose outcome was lost.
  Requires **gateway 2.18.0** or later (Nimbus#1325).

- **The trust panel counted the gateway's bookkeeping as things it had done.**
  "N outbound actions recorded" was counting every row in your gateway's record,
  including the entries it writes about itself — a marker at each startup, and
  now one per completed fetch. The line now counts only actions, so the number
  matches what the Activity page lists.

- **A page could decide which of your clips it overwrote.** The address a page
  declares as its canonical one was forwarded to Nimbus exactly as written, and
  Nimbus files a clip under that address — so a page declaring a relative
  address (`/blog`) could collide with an unrelated site that declared the same
  one, and a site declaring its homepage as the canonical address for every page
  made each clip from that site overwrite the last. Both silently destroyed the
  earlier clip. A declared address is now resolved against the page and refused
  when it would file the clip somewhere it does not belong, and the pre-send
  preview says when that happened and why.
- **Related items showed you the title twice.** Every related result's preview
  line was an extract of its own title, printed directly beneath that title, so
  the lane repeated itself instead of telling you anything about the item. It now
  previews the item's actual content.
- **Related hid the results most likely to help.** On a page whose site Nimbus
  recognised — a GitHub pull request, say — every other item from that same site
  was filtered out of Related, which on a working surface is exactly where all
  your context lives. Related now excludes only the page you are on.
- **The built-in sites could not be granted page access at all.** Options listed
  only the self-hosted instances you had added, and the Grant button lives on a
  row — so `github.com`, `gitlab.com`, `bitbucket.org` and Jira Cloud, which
  Nimbus recognises without any setup, had no row and no way to be granted. They
  are now listed alongside your own entries, each with its own page-access
  control (and no Remove — they are not yours to delete).
- **The panel's freshness line said "Indexed" when it meant "Updated".** The time
  shown is the item's own last-modified time as its source reports it — GitHub's
  `updated_at` for a pull request — not when Nimbus indexed it. So a PR fetched
  seconds ago could read "Indexed 3 days ago", which was simply untrue. The line
  now reads "Updated 3 days ago". The value is unchanged and is the more useful
  one: how stale the underlying item is, rather than when a row was written.
- **The panel could describe one page and answer about another.** On sites that
  navigate without reloading — GitHub, GitLab and Jira all do — moving to a
  different pull request while the panel was open left the header naming the page
  you started on, while expanding a lane answered about the page you had moved to.
  The panel now sticks to the page you opened it on, says so when you navigate
  away — *"You've moved on. This panel is still about acme/web #482."* — and
  offers one button to re-read the page you are on now. Its lanes keep working on
  the item the header names the whole time, and the notice disappears by itself if
  you navigate back.
- **Agent lanes appeared on pages they could not answer about.** A Jira issue or a
  Jenkins build that Nimbus had indexed offered *What breaks if it lands* and *Who
  should review it*, which are questions about a change under review. Both lanes
  now appear on pull requests only.
- Unpairing, and a confirmed re-pair, now both clear cached agent answers, so a
  brief can no longer outlive the gateway that produced it.

### Added

- **You can now see what your gateway went and got for you.** Nimbus could
  already show you everything that left the browser before it left; what it
  could not show you was the other direction — the fetches and agent runs it
  asked your gateway to make on your behalf. A new **Activity** page lists them:
  when, which service, what kind of action, and whether it was authorised or
  blocked. It is read from your gateway's own append-only record every time you
  open it, and Nimbus keeps no copy of its own, so the page cannot quietly
  disagree with `nimbus prove`. You can check the record's tamper-evident chain
  on demand — the page never claims it is verified until you ask — and export
  the signed result. The "Where your data goes" panel gains the matching
  one-line summary and a way in. Requires **gateway 2.16.0** or later
  (Nimbus#1319); an older one is named as such rather than shown an empty list.
  The scope it needs is granted to an existing pairing with
  `nimbus clip scopes <device> --set <scopes>` — no re-pairing.

- **A clip is now a record you can cite.** Every clip carried the page's text
  and its address and nothing else — the byline, the publication date, the
  publication's name, the language and the article's lead image were all sitting
  in the page and all thrown away, so a saved article could not be attributed or
  dated without opening the original again. Nimbus now keeps them, taking
  Readability's reading where it has one and the page's own tags where it does
  not, on selections and hard pages too. Everything kept appears in the pre-send
  preview before anything leaves; a lead image hosted on a CDN is kept, while one
  declared as a `data:` or `javascript:` address is refused. Requires **gateway
  2.12.0** or later (Nimbus#1288) — an older gateway accepts the clip and stores
  no metadata, with no error to tell you so.
- **Why does this change exist — the third review question.** A resolved pull
  request offered *what breaks if it lands* and *who should review it*; the
  question that comes before both was missing, because answering it needed a
  local checkout of the repo. It no longer does. The lane appears on pull
  requests alongside the other two and answers from what Nimbus has indexed —
  the pull request itself, the ticket it references, the discussion around it,
  and what was happening when it was opened. Two of the answer's parts stay
  silent on a pull request — line-level authorship, and downstream impact, which
  the impact lane already answers — and the answer says so itself rather than
  quietly coming back shorter. Requires a gateway with the `{ prUrl }` arm of
  `agents.why` — **gateway 2.8.0** or later (Nimbus#1260); on an older gateway
  the lane fails with a generic error.
- **Ask a brief to draw on what you already know.** A research brief was built
  only from the tabs you picked and the passages you highlighted; everything
  Nimbus had already indexed sat one process away and was never consulted. Tick
  **Also search what Nimbus has indexed** in the composer and the gateway
  searches it with your question and may draw on up to 8 matching items, cited
  in the finished
  brief and marked as coming from your index rather than from a tab you chose.
  Off unless you turn it on, and your choice is remembered — it is also in
  Options, with the same one-line description beside it. Because the client
  cannot know which items the gateway will find, the pre-send preview names the
  bound rather than pretending to list them, and says plainly that your question
  is the text being searched — and that searching may send it to whichever
  embedding provider your gateway is configured to use. Today the gateway's
  brief search covers your saved web clips only; the wording will widen when the
  search does.
- **Highlight the parts that matter, not the whole page.** Select text on any
  page and right-click → **Add to brief**. The text is captured the moment you
  highlight it, so it's still there even if you close the tab. Highlight
  several passages, on one page or several, and they show up in the brief
  composer as sources you can pick — a page you highlighted three times counts
  as one source holding all three, in the order you collected them. The
  pre-send preview shows the exact text that will be sent, and sending a brief
  removes the passages it used from your collection (a run that fails, or a
  source you switch back to the whole page, keeps them).
- **Ask one question across several tabs you have open.** A new research-brief
  page lets you pick the pages you have open, choose a question Nimbus suggests
  from what those pages are, and get back a brief with findings, the places your
  sources disagree, and an honest list of what it could not cover. Every finding
  cites the page it came from. Open it from the toolbar popup or from Options.
  It works on the sites you have granted page access to; other tabs are counted,
  never named, because Nimbus cannot read them. A page that can't be read doesn't
  sink the brief — it finishes and tells you which one was missing.
- **A record of what left.** Options now lists every research brief you have run:
  when, how many pages, whether any were shortened to fit, and whether the answer
  came from a model on your own machine or a remote one. Nimbus's own audit trail
  does not cover model calls, so this list is kept in your browser — and it
  survives unpairing, because a past send does not un-happen.
- **Save a copy when Nimbus can't reach a page itself.** On a site Nimbus has no
  connector for — an internal wiki, a vendor console — the panel now offers to
  save a copy of the page so your agents have something to work with. It appears
  only where nothing better is available: if Nimbus can fetch the page properly,
  it still offers that instead.
- **A saved copy says it is one.** On a site Nimbus recognises, a page you
  captured is labelled as your own copy rather than connector data, whether you
  saved it a minute ago or a month ago, and can be refreshed with **Update this
  copy**. On a site Nimbus has no connector for at all — the case above — that
  label isn't reachable again after you close the panel; the confirmation that
  your copy was saved is shown once, right after you save it.
- **Related is about the item, not the tab title.** On a page Nimbus has resolved,
  Related now asks about that indexed item rather than searching for whatever the
  browser tab happens to be called — so a Jenkins page stops searching for
  "build #42 [Jenkins]".
- **Related results say what they are and how fresh they are.** Each result now
  carries its kind — pull request, issue, CI run — and when it was last updated,
  and results are grouped under the service they came from with a count.
- **See exactly what leaves, before it leaves.** Clipping from the toolbar now
  shows you the whole payload first — title, URL, tags, and the body it will
  send — and sends nothing until you say so. The hotkey and right-click stay one
  gesture and tell you afterwards, as before. You can switch the preview off in
  Options if you'd rather not be asked.
- **Asking Nimbus to fetch an item tells you which item.** The panel's fetch
  button now names the service, the type and the address before your gateway
  reaches out for it.
- **Ask Nimbus what a word means, on any page.** Select a term, right-click →
  **Define in Nimbus**, and the panel answers from your own glossary. It works
  wherever the panel opens — including pages Nimbus does not recognise, because
  this question is about the word, not the page; the term is all that is sent, no
  URL. Select a passage instead of a phrase and it says so rather than answering
  about the first few words of it.
- **See what's related to a phrase, not just to the page.** Select text →
  **What's related to this?** and the Related lane re-runs against exactly that.
  Both new entries reach an already-open panel without closing it.
- **Picking which item a page is now gets you the answers.** When Nimbus cannot
  tell which indexed item an ambiguous page is, it asks — and until now, choosing
  one left you looking at a header with no lanes under it. The two pull-request
  lanes now appear on the item you picked, and answer about that item.
- **The related panel no longer depends on a keyboard shortcut that may not
  exist.** Right-click any page → **Show related in Nimbus** opens the same
  panel the hotkey does. And Options now lists each Nimbus shortcut with the
  keys your browser *actually* bound — `Alt+Shift+R` is only a suggestion, and
  when another extension already claims it your browser silently leaves it
  unset. A shortcut that never bound now reads **Not set** instead of looking
  like a broken feature.
- **Nimbus can find itself.** Setting up no longer starts with typing a URL:
  press **Find my gateway** and the extension checks the two places a local
  Nimbus listens. It checks exactly those two — it does not scan your ports.
  The URL field is still there for a gateway on a different port.
- **Options tells you the truth about the connection.** One line now says where
  you are connected, when the last clip landed, and how many are waiting to sync
  — and when your gateway has rejected this browser, it says *"Needs
  re-pairing"* instead of leaving you to guess whether Nimbus is even running.
- **One page that answers "where does my data go?"** Options now states the one
  destination Nimbus talks to, which sites you have granted page access to, what
  gets sent and when, and what happens to your pairing token — driven by your
  real settings, not by a fixed blurb.
- The panel now recognises a product's own dashboard — GitHub, GitLab, Bitbucket,
  Jira and Jenkins — and offers three lanes there: *What happened while I was
  away*, *What got decided* and *Who owns what*. They answer across the whole
  connector, which is what the header says, and they need no indexed item.
- **Nimbus can now tell you it knows this page, before you ask.** On a site you
  have granted page access to and switched **Surface automatically** on for,
  landing on a pull request, build or issue that Nimbus has already indexed puts
  a small cue in the corner naming it. Click it and the panel opens on that item;
  dismiss it and it stays quiet for that item in that tab. Nothing runs until you
  click — no agent, no lane. And the cue only appears when there is a real answer
  behind it: a page Nimbus has not indexed, a page it cannot pin to one item, or
  a gateway that is not running all produce silence rather than a cue that leads
  nowhere.
- **Ask an agent about the pull request you are looking at.** When the panel has
  resolved a PR to a single indexed item, it now offers two lanes — *what breaks
  if it lands*, and *who should review it*. Expanding one runs the agent behind
  it; nothing runs until you ask. Answers survive closing the panel: reopening it
  and expanding the lane shows the same brief again without running the agent a
  second time. If a lane can't answer it says why, and offers a re-run wherever
  retrying could actually help — where it can't, it names the thing to fix
  instead, such as granting the `agents` scope. On a page that matches several indexed items the lanes
  are not offered, even after you pick one — the run would resolve the page again
  and hit the same ambiguity, so a lane there could only ever fail.
- **On a resolve miss, fetch that one item.** On a page Nimbus recognises but has
  not yet indexed, the panel now offers to fetch that item through the connector
  that owns it — a GitHub PR, a Jira issue, a Jenkins build. Nothing is fetched
  until you ask: the button names exactly what it will fetch and from where (e.g.
  *"Fetch this from GitHub"*), and only ever fires once per panel. An unconfigured
  connector says so plainly instead of inviting a retry that can't work, and if the
  gateway is just slow to answer, the panel says it's still working rather than
  reporting a failure.
- **The panel knows what page you're on.** On a Bitbucket, GitHub or GitLab pull
  request, a Jenkins build or a Jira issue, the related-items panel now leads with
  what the page is — *"GitHub PR · acme/web #482"* — and, where the gateway
  supports it, the exact indexed item it resolves to. Resolution is at most one
  item: on a miss the panel says "Not indexed" rather than passing loose search
  hits off as the page. Related items move into a collapsible lane below the
  header, which is where the planned agent lanes will join them. The panel is
  still opened by you (`Alt+Shift+R` or the popup button) — nothing appears on its
  own, and the Related lane keeps working in every header state.
- **Self-hosted instances are configurable.** Bitbucket Cloud, GitHub, GitLab and
  Jira Cloud are recognised with no setup. Self-hosted Bitbucket, Jenkins and Jira
  are added under **Recognised surfaces** in Options as a URL plus which product it
  is — including instances behind a reverse proxy on a sub-path, e.g.
  `https://corp.example/jira`, and several products on one host. The product is
  never guessed from the URL shape, so the panel cannot be confidently wrong about
  where you are.
- **Opt-in page access, per host.** Options can grant Nimbus permission to
  recognise pages on a site without you opening the panel first, and revoke it
  again. Nothing is granted at install. This is page access only — it does not
  change where Nimbus can send data, which remains your local gateway on
  `127.0.0.1` and nothing else.

### Changed

- **The privacy policy now lists everything the extension keeps on your device,
  not just two of the things.** It described the pairing token and the offline
  clip queue, and said nothing about the passages you collect, the answers the
  gateway sends back, the local disclosure log, or the sites you configured for
  recognition — all added by the phases since, and all of which stay on your
  machine. It now also states plainly that the broad page-access patterns are
  opt-in per site and are not somewhere the extension sends anything, and that a
  brief answered by a remote model is your gateway reaching out, not this
  extension.

- The panel now resolves pages against the gateway's shipped
  `GET /v1/items/resolve` route instead of the guessed shape Phase C1 was built
  against. It shows when the item was last updated, marks a closest-match result
  as weaker than an exact one, and lets you pick when several indexed items match
  the page. The not-paired, pairing-rejected and can't-reach-Nimbus messages for
  resolve are reworded to match the new contract, and a malformed resolve
  response now says "Couldn't read Nimbus's answer." instead of a generic error.
- **Scope guidance is a command you can paste, and one that's safe to run.**
  When a pairing predates a scope the panel needs (`resolve`, and now `fetch`),
  the fix-it text names your actual device and the exact resulting set, built
  from the gateway's own 403 response — not a guessed list. That matters
  because `nimbus clip scopes … --set` *replaces* the device's scope set
  rather than adding to it, so a guessed list could silently drop a scope you
  already held (e.g. `agents`).

## [0.2.0] - 2026-07-28

### Added

- **Quick-clip entry points.** Clip the current page or selection without opening
  the popup — via a right-click context menu ("Clip page / selection to Nimbus")
  or the `Alt+Shift+C` / `Alt+Shift+S` shortcuts (rebindable). The result is
  confirmed by an in-page toast (saved / offline-queued / error, worded exactly
  like the popup's status line), with a toolbar-badge flash on pages a script
  can't be injected into. A right-click always clips the tab that was clicked,
  even when it isn't the focused window's active tab. Adds the `contextMenus`
  permission; loopback-only and the locked clip contract are unchanged.

### Fixed

- **Oversized clips no longer retry forever.** The gateway rejects clip bodies
  over its size cap with `413 payload_too_large`; this was previously mapped to
  the generic `server_error` and treated as a transient/offline failure, so the
  clip was queued and silently retried on every flush — a retry that can never
  succeed. It's now a distinct, terminal `payload_too_large` reason: the popup
  and quick-clip toast report "Too large for Nimbus to save.", the item is not
  queued, and any already-queued entry that hits this on its next attempt stops
  auto-retrying (manual retry from the queue is still available).
- **The offline queue could stop draining for frequent clippers.** The flush alarm
  was re-created on every queue change, and `chrome.alarms.create` replaces a
  same-named alarm and restarts its countdown — so clipping more often than once a
  minute pushed the next flush out indefinitely and queued clips drained only when
  the service worker restarted. The alarm is now created once and left alone,
  except when it is deliberately re-paced for a rate-limit pause.
- **Clips are no longer hammered when the gateway rate-limits.** The
  gateway caps `POST /v1/clips` at 20/min and answers `429` with a `Retry-After`;
  this was previously mapped to the generic `server_error`, so the popup reported a
  server failure and the offline queue re-POSTed every entry on the next tick. A
  `429` is now a distinct `rate_limited` reason: the clip is queued (it is
  transient, not terminal), the popup and quick-clip toast both say "Nimbus is busy
  — queued, will retry shortly.", the flush stops the round on the first `429`
  instead of draining into a closed window, and the next flush is paced off the
  gateway's `Retry-After` rather than the fixed one-minute alarm. A successful clip
  clears the pause early.
- **Duplicate "Clip to Nimbus" context-menu entries after an extension reload.**
  `removeAllMenus()` awaited `chrome.contextMenus.removeAll()`, which is not
  thenable per the pinned `@types/chrome`, so teardown resolved before the removal
  actually completed and a following create could race it into duplicate menu ids.
  The removal is now promisified via its callback (which also works on Firefox
  MV3). (#19)

## [0.1.0] - 2026-07-19

### Added

- **Slice 1 — the end-to-end clip core.**
  - **Pairing:** the Options page redeems a 6-digit gateway code
    (`POST /v1/clips/pair/confirm`) to mint a long-lived bearer token, stored in
    `chrome.storage.local` and held by the background service worker.
  - **Capture:** readable-article extraction (Mozilla Readability, bundled) or
    the current selection, with a meta-description/URL bookmark fallback when no
    article is found.
  - **Clip ingest:** the toolbar popup clips the page or selection via
    `POST /v1/clips` with `Authorization: Bearer`, with per-reason status and
    error messaging.
- Thin typed `chrome.*` seam (`src/browser/`) that keeps pair/clip
  orchestration, payload building, tag parsing, origin validation, and status
  mapping pure and unit-tested.
- `docs/development.md` — dev-load steps and a manual verification checklist for
  the surfaces that are not unit-tested (capture-in-page, popup/options DOM,
  service-worker glue).
- **Slice 2 — related-items sidecar.** An on-demand Shadow-DOM panel (opened from a
  "Show related" popup button or the `Alt+Shift+R` hotkey) that queries
  `POST /v1/clips/related` and lists related indexed items for the current page
  (title, service badge, snippet, link). Query-once-on-open; toggle / X / Esc to
  close. Renders via `textContent` only (DOM-XSS backstop); honors
  `prefers-color-scheme`. No new permissions.
- **Slice 3 — offline retry queue.** Clips that fail because the gateway is
  unreachable (or errors) are saved to a local queue and retried automatically — a
  `chrome.alarms` flush (live only while the queue is non-empty) plus drains on
  service-worker startup and on demand. A toolbar **badge** shows the pending count
  and the popup gains a **queue manager** (per-item Retry/Remove + Retry all). The
  bearer token is never stored in the queue (re-read at flush time); queue writes are
  serialized to prevent lost updates; the manager renders `textContent`-only and no
  links. Adds only the `alarms` permission; still loopback-only.
- **Connection management (Options).** The Options page now shows the current
  pairing — *"Paired as "<label>" to <origin>, since <date>."* — and adds an
  **Unpair** button (inline two-step confirm) that clears the stored connection. The
  state is fetched from the service worker as a **token-free** projection (the bearer
  token never enters the Options page). Unpair is local-only (the gateway contract has
  no revoke endpoint); queued offline clips survive an unpair and drain after
  re-pairing. No new permission.
- **Extension icons.** Real 16/48/128px toolbar and store icons (a Nimbus cloud
  with a clip/bookmark tag on a brand-blue tile), replacing the placeholder
  squares. Generated reproducibly by `scripts/gen-icons.py` (Python stdlib only,
  not part of the extension build).
- **Automated store publishing.** On a `vX.Y.Z` tag, `publish.yml` now uploads the
  built extension to the Chrome Web Store and Firefox AMO and submits each for
  review, in addition to attaching the zips to the GitHub Release. Firefox
  submissions include a `git archive` source bundle for AMO's source-code policy.
  Store steps run only when the store credentials are configured (see
  `store/publishing.md`); until then a tag still cuts a GitHub Release. The store
  CLIs (`chrome-webstore-upload-cli`, `web-ext`) are pinned devDependencies.

### Security

- **Loopback-only** network surface (`127.0.0.1` / `localhost`); origin
  validation uses the URL parser and rejects lookalike hosts such as
  `127.0.0.1.attacker.com`. HTTPS is excluded by design.
- The **bearer token is the only secret** — confined to the service worker and
  extension storage; never logged, never placed in the page or popup/options
  DOM, and never returned to the UI. The pairing code is likewise never logged.

[Unreleased]: https://github.com/nimbus-agent/nimbus-web-clipper/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/nimbus-agent/nimbus-web-clipper/compare/v0.2.0...v0.5.0
[0.2.0]: https://github.com/nimbus-agent/nimbus-web-clipper/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nimbus-agent/nimbus-web-clipper/releases/tag/v0.1.0
