# authoring-ops-mcp — plan

**Status: steps 1–3 of "Order of work" are built and run against the live suite (2026-11-16). It isn't deployed:
the container doesn't exist yet. Skills (step 4) and the portal (step 5) aren't started.**

## What it is

The ops server for the **authoring** suite: the MCP servers behind the Authoring Portal
(`https://authoring.majerus.us`) and the services they rely on. It has two sides:

- **A web dashboard** on the LAN: one page showing whether every server in the suite is up, what
  each one runs, and whether they still agree with each other and with the skills.
- **An MCP side** in the portal: a few read-only tools, so an agent can ask
  "is the suite healthy, and if not, where do I look?" without calling each server.

It reads and reports, and changes nothing. Like holdings-mcp's checks, each finding names the
repository that owns the fix.

### Naming

"authoring" is a suite name. Other portals and tool suites will come later, so names are
suite-qualified, with `-mcp` last:

- repository and service: `authoring-ops-mcp`
- LXC host: `authoring-ops-mcp.localdomain`
- a later suite gets its own `<suite>-ops-mcp`, built from the same code with a different config
  (see "Engine and suite config")

Concept Clusters (`cc-authoring.localdomain`) is a client of the portal. It isn't part of the suite.

## Why a separate server

- corpus-mcp's dashboard shows only corpus-mcp's view: the services it uses, plus terminology-mcp's
  subscribers (PR #48). No server shows the whole suite.
- holdings-mcp already reads every service and runs cross-service checks
  (`docs/cross-service-checks.md` there), but its job is "what do I have, and in what form?" The
  checks about *services*, rather than *works*, sit there because there was nowhere else to put them.
- The skills moved to their own repository (`authoring-skills`, 2026-11-14), and their drift check
  belongs with the servers they depend on, not with holdings.

## The suite today

Measured on 2026-11-16. Every service listens on port 8000.

| Service | `/health` | Tools | Notes |
|---|---|---|---|
| corpus-mcp | yes | 15 | admin UI, dashboard |
| quote-mcp | yes | 11 | |
| terminology-mcp | yes | 14 | subscriber registry at `GET /api/subscribers`; its `version` is the changelog head |
| holdings-mcp | yes | 3 | cross-service checks at `GET /api/checks`; deployed with uncommitted changes |
| iasp-mcp | yes | 9 | |
| zotero-mcp | **no** | 38 | third party (54yyyu); needs an MCP session, so it's probed with the SDK client |

That's 90 tools, 92 with this server's two. The first draft said about 103, with zotero-mcp at about 55. Either
the portal counts something these listings don't (its own `portal_*` tools account for three), or zotero-mcp
was trimmed since. Worth one look at the portal's toggle list before choosing a budget.

## Boundaries

| Concern | Owner | Notes |
|---|---|---|
| Is each service up, and what is it running? | **authoring-ops-mcp** | built |
| Which tools each service lists | **authoring-ops-mcp** | built (counts and names) |
| Whether the skills' tools still exist | **authoring-ops-mcp** | step 4; until then it stays in holdings-mcp and shows here as one of its checks |
| Is each subscriber current on the terminology? | terminology-mcp (registry) | ops-mcp reads and shows it |
| Do works, keys, quotes, and anchors agree between services? | holdings-mcp | stays: those checks need holdings' mirror |
| A service's own state (intake, uploads, jobs) | each service's admin UI | ops-mcp links to it |
| Skill text, examples, and `check-draft` | authoring-skills | see "Guidance" |
| Portal configuration (servers, tool toggles, Code Mode) | Cloudflare dashboard | ops-mcp reports the suite's tool total; it never changes the portal |
| Proxmox: containers, disks, restarts | the user | see "Not in scope" |

holdings-mcp's checks are read from its `GET /api/checks`, not run twice.

## The health contract

Written down in [docs/health-contract.md](docs/health-contract.md), from what the servers return today.
`ok`, `version`, and `deployed` exist everywhere. `service`, `dependencies`, and `admin` are new and optional.

## Engine and suite config

The code names no service. [suites/authoring.json](suites/authoring.json) names the suite, and `OPS_SUITE`
chooses the file. A second suite later is a second config and a second LXC, not a fork.

## Dashboard (web side)

One page, reloaded every minute:

1. **Services** (built): one row each, showing up/down and for how long, version, deployed commit and its age,
   a pill when the branch isn't `main` or the checkout was unclean, tool count, and a link to its admin UI.
2. **Findings** (built): everything open, grouped by who owns the fix, worst and oldest first.
3. **Subscribers** (built): terminology-mcp's registry (state, schemes, last seen).
4. **Skills** (step 4): the pinned authoring-skills version, and any tool the skills call that a service no
   longer lists.

Status pills say what state something is in. The page has no buttons, because it has no actions.

## MCP tools

| Tool | Returns |
|---|---|
| `status` (built) | one row per service: up/down and since when, version, deployed commit and branch, tools; each subscriber's lag; the tool total; the count of open findings |
| `findings` (built) | open findings, each with its severity, who owns the fix, and when it was first seen |
| `get_skill` (step 4, if still wanted) | a skill's text from the pinned authoring-skills version |

## What the findings are

| Finding | Severity | Fix in |
|---|---|---|
| A service doesn't answer `/health` (or, with none, a tool listing) | fail | its repository |
| A service answers `/health` but not a tool listing | fail | its repository |
| Deployed from a branch other than `main` | drift | its repository |
| Deployed from a checkout with uncommitted changes | drift | its repository |
| A dependency a service reports as not ok (`dependencies` in the contract) | fail | its repository |
| A subscriber is blocked on the terminology | fail | the subscriber |
| A subscriber has been behind for 30 minutes | drift | the subscriber |
| A subscriber hasn't asked for changes in an hour | drift | the subscriber |
| Each holdings-mcp check at `fail` or `drift` | as holdings says | as holdings says |
| The registry or the checks can't be read for five minutes | fail | terminology-mcp or holdings-mcp |
| The tool total is over `tool_budget`, when one is set | drift | the portal's toggles |

## Changes from the first draft, and why

- **`/api/checks`, not `/api/worklist`.** holdings-mcp has no JSON worklist; `/worklist` is an HTML page.
  `/api/checks` has every check with its owner and first-seen time. What it lacks is the worklist's
  dismissals, so an item dismissed there still shows here (see "Open questions").
- **JSON config, not YAML.** No parser to add, and the file is small.
- **No SQLite.** "Down since" and "open for" need only a few timestamps, kept in one JSON file. This also
  means no native module to compile on the host. Add a database when something asks for uptime over time.
- **Tool names are `status` and `findings`.** The portal adds the server's prefix, as it does for
  `holdings_status`, so `suite_status` would have read `ops_suite_status`.
- **`dependencies`, not `checks`, in the health contract.** holdings-mcp's `/health` already uses `checks`
  for a summary object.
- **zotero-mcp is listed every poll**, not every ten minutes: with no `/health`, its listing is the only sign
  of life, and a ten-minute cache would hide an outage for ten minutes.
- **The dashboard and `/health` are LAN only; `/mcp` alone goes through Access.** holdings-mcp's public
  root page has no counterpart here.
- **Deploy has no `--main` yet.** It deploys the current checkout and records `dirty`, as holdings-mcp's does.
  corpus-mcp's `--main`, `--pr`, and `--current` can come once the repository has a remote.

## Guidance

- **Skills.** Recommended change: don't fetch from GitHub at run time. authoring-skills has no tags yet (so
  `ref: v0.1.0` names nothing), and a run-time fetch adds a token and a dependency on github.com to a server
  whose job is to say what's up. Instead the deploy copies the skills, at a tag, from the sibling checkout
  into the release, and `/health` reports the tag. Also: serve them one way. Resources and prompts are
  ignored by the clients that need this most, so `get_skill` alone covers it, at the cost of a third tool.
- **The skills' tool list.** `TOOLS_SKILLS_USE` moves out of holdings-mcp. Best home: a
  machine-readable file in authoring-skills (e.g. `tools-used.json`), checked by authoring-skills'
  own tests against the skill text, and read by authoring-ops-mcp to check against the live listings.
  A rename then becomes one change in one repository.
- **Ops runbooks** (later): short docs on how to deploy, how to read a finding, and what to do when a
  service is down. They describe steps for a person; the server never runs them.

## Not in scope

- Restarting, deploying, or changing any service. Deploys stay with each repository's
  `npm run deploy`.
- Anything destructive on Proxmox. If the dashboard ever shows host data (container up, disk use),
  it reads it through a read-only API token, and the user acts on it.
- Changing portal settings.
- Replacing each service's own admin UI.

## Order of work

1. **Skeleton.** Built: TypeScript, Node 22, `@modelcontextprotocol/sdk`, holdings-mcp's layout and deploy
   tooling, the config loader, `/health` under its own contract. Left: the user creates the LXC
   `authoring-ops-mcp.localdomain`; then `npm run deploy -- --provision`, `--env`, and a first deploy. The
   deploy script is adapted from holdings-mcp's and hasn't been run.
2. **Service probes.** Built: `/health` for the five, `tools/list` for all six, the services table, `status`.
3. **Subscribers and holdings findings.** Built, with `findings`.
4. **Skills.** `tools-used.json` in authoring-skills and a first tag; the drift check here; remove
   `TOOLS_SKILLS_USE` and `tools-skills-use` from holdings-mcp in the same release. `get_skill` if wanted.
5. **Portal.** Add authoring-ops-mcp to the Cloudflare portal (with Access, as the others), and check
   Claude Code's `authoring` MCP entry points at `authoring.majerus.us`.
6. **Health contract fixes**, server by server, as each is next touched: terminology-mcp's `version`,
   `dirty` in corpus-mcp and terminology-mcp, then the optional fields.

## Open questions

- **Commit vs. GitHub `main`**: recommended no, for now. Branch and `dirty` already catch "not what main
  says", and the deploy age catches "hasn't moved in a while". What's missing is "main has moved on", which
  costs a token and a dependency on github.com. Revisit if a stale deploy ever goes unnoticed.
- **Worklist dismissals**: a finding dismissed on holdings-mcp's `/worklist` still shows here. Either
  `/api/checks` gains a `dismissed` mark on its examples, or this stays as it is and the dashboard is the
  undismissed view.
- **Who owns a holdings finding**: its `fix` is prose ("corpus-mcp for a book, quote-mcp for quotes"), so
  grouping by owner groups by sentence. A `repo` field beside it in `/api/checks` would fix that.
- **Tool budget**: what number should the portal total be held under? Set `tool_budget` in the suite config
  to get a finding when it's passed. Ways to trim zotero-mcp without a fork: `ZOTERO_MCP_TOOLSETS` upstream,
  the portal's per-tool toggles, and Code Mode.
- **Alerts**: dashboard only, or also a push (email, ntfy) when a service has been down for N minutes?
  Nothing watches this server either: if it's down, the dashboard is.
- **Concept Clusters**: it appears as a subscriber, and a finding about it names `concept-clusters` as the
  owner. Enough, or does it want a row?
