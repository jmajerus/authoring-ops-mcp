# authoring-ops-mcp — plan

**Status: steps 1–5 of "Order of work" are done (2026-11-17). It is deployed to `authoring-ops-mcp.localdomain`
with the skills at authoring-skills `v0.1.0`, behind its own Cloudflare Access application, and in the portal
as `suite`.**

## What it is

The ops server for the **authoring** suite: the MCP servers behind the Authoring Portal
(`https://authoring.majerus.us`) and the services they rely on. It has two sides:

- **A web dashboard** on the LAN: one page showing whether every server in the suite is up, what
  each one runs, and whether they still agree with each other and with the skills.
- **An MCP side** in the portal, under the prefix `suite`: the front door for an agent. Its instructions say
  which server does what, its tools say whether the suite is healthy and where to look if not, and it serves
  the skills to sessions that have none installed.

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

That's 90 tools, 94 with this server's four. The first draft said about 103, with zotero-mcp at about 55. Either
the portal counts something these listings don't (its own `portal_*` tools account for three), or zotero-mcp
was trimmed since. Worth one look at the portal's toggle list before choosing a budget.

## Boundaries

| Concern | Owner | Notes |
|---|---|---|
| Is each service up, and what is it running? | **authoring-ops-mcp** | built |
| Which tools each service lists, and whether the skills' tools still exist | **authoring-ops-mcp** | built; moved from holdings-mcp |
| Suite-level guidance for an agent (which server does what) | **authoring-ops-mcp** | built; the text is in the suite config |
| Serving the skills to clients that can't install them | **authoring-ops-mcp** | built; a copy pinned at deploy |
| Is each subscriber current on the terminology? | terminology-mcp (registry) | ops-mcp reads and shows it |
| Do works, keys, quotes, and anchors agree between services? | holdings-mcp | stays: those checks need holdings' mirror |
| A service's own state (intake, uploads, jobs) | each service's admin UI | ops-mcp links to it |
| Skill text, examples, `check-draft`, and the list of tools the skills call (`tools-used.json`) | authoring-skills | see "Guidance and skills" |
| Portal configuration (servers, tool toggles, Code Mode) | Cloudflare dashboard | ops-mcp reports the suite's tool total; it never changes the portal |
| Proxmox: containers, disks, restarts | the user | see "Not in scope" |

holdings-mcp's checks are read from its `GET /api/checks`, not run twice.

### holdings-mcp and this server

They stay separate. holdings-mcp is a catalogue with a store, and corpus-mcp and quote-mcp read Zotero through
it, so it's one of the things this server watches: folded together, a failed holdings migration would take the
dashboard down when it's needed. They are also two different front doors. A writing task still starts at
holdings' `find_work`; this server is where an agent finds its way around, or finds out what's broken.

The rule for a check: it belongs in holdings-mcp if it needs the store of works to answer, and here otherwise.
So the works, keys, quotes, and anchors checks stay there, with "readers in step" (only holdings sees who read
`/zotero`) and the worklist with its dismissals. Each holdings check that isn't passing is one line here, with
a link to the worklist; the examples, and dismissing one, stay there.

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
4. **Skills** (built): the pinned authoring-skills ref and commit, the skills' names, and whether every tool
   they call is still listed.

Status pills say what state something is in. The page has no buttons, because it has no actions.

## MCP tools

| Tool | Returns |
|---|---|
| `status` | one row per service: up/down and since when, version, deployed commit and branch, tools; each subscriber's lag; the skills' ref; the tool total; the count of open findings |
| `findings` | open findings, each with its severity, who owns the fix, and when it was first seen |
| `list_skills` | each skill's name, description, and files, and the ref they come from |
| `get_skill` | a skill's `SKILL.md`, or another of its files, as text |

Through the portal these are `suite_status`, `suite_findings`, `suite_list_skills`, and `suite_get_skill`.
The two skill tools are registered only when the release carries skills.

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
| Each holdings-mcp check at `fail` or `drift` (one line, linked to the worklist) | as holdings says | as holdings says |
| A service no longer lists a tool the skills call | fail | the service; or authoring-skills, if the rename was meant |
| The skills name a tool that `tools-used.json` leaves out | drift | authoring-skills |
| `tools-used.json` names a service the suite doesn't have | fail | authoring-skills |
| The pinned skills have no `tools-used.json` | drift | authoring-skills |
| The registry or the checks can't be read for five minutes | fail | terminology-mcp or holdings-mcp |
| The tool total is over `tool_budget`, when one is set | drift | the portal's toggles |

## Changes from the first draft, and why

- **`/api/checks`, not `/api/worklist`.** holdings-mcp has no JSON worklist; `/worklist` is an HTML page.
  `/api/checks` has every check with its owner and first-seen time. What it lacks is the worklist's
  dismissals, so an item dismissed there still shows here (see "Open questions").
- **JSON config, not YAML.** No parser to add, and the file is small.
- **No SQLite.** "Down since" and "open for" need only a few timestamps, kept in one JSON file. This also
  means no native module to compile on the host. Add a database when something asks for uptime over time.
- **Tool names are bare (`status`, `findings`).** The portal adds the server's prefix, as it does for
  `holdings_status`. With the prefix `suite` they read as the first draft wanted: `suite_status`.
- **`dependencies`, not `checks`, in the health contract.** holdings-mcp's `/health` already uses `checks`
  for a summary object.
- **zotero-mcp is listed every poll**, not every ten minutes: with no `/health`, its listing is the only sign
  of life, and a ten-minute cache would hide an outage for ten minutes.
- **A public page at `/` and an admin page at `/admin`**, as the sibling servers have. `/` is safe for anyone to
  see (findings' `summary` only; `detail`, addresses, and links to writable pages stay off it) and is open through
  the tunnel without a token, as holdings-mcp's root is. The shared Access application covers `/mcp` alone on
  each host (2026-11-17; it had covered whole hosts), so outsiders reach `/`. `/admin`, `/health`, and `/api/*` are LAN only; `/mcp` goes through Access.
- **Deploy has no `--main` yet.** It deploys the current checkout and records `dirty`, as holdings-mcp's does.
  corpus-mcp's `--main`, `--pr`, and `--current` can come once the repository has a remote.

## Guidance and skills

- **Guidance** is this server's MCP instructions: a sentence on what the server is, the suite's routing (the
  `guidance` lines in the suite config, so the code still names no service), when to call `status`, and how to
  get a skill. It's about a thousand characters and should stay near that. The portal joins every server's
  instructions and cuts the result off at a length; in one session iasp-mcp's were cut short.
- **Skills are a copy, pinned at deploy.** `npm run deploy` runs `tools/vendor-skills.mjs`, which takes
  authoring-skills at the ref in the suite config (`skills.ref`) from the checkout beside this one and puts it
  in the release. Nothing is fetched at run time, so the server that says what's up doesn't depend on
  github.com. `/health`, `status`, the dashboard, and every `get_skill` answer name the ref and commit.
  Links to a shared file are copied as the file, so each skill folder stands alone.
- **An installed skill wins.** The instructions and `list_skills` say so: the served copy is for sessions with
  none installed. A skill that runs a script (`cited-article`'s `check-draft.mjs`) can't run it in a client
  with no shell; `get_skill` says to do the step by hand or say what went unchecked.
- **The skills' tool list** is `tools-used.json` in authoring-skills, by each service's own tool names.
  authoring-skills' tests check that every tool in it is named in a skill. This server checks the rest
  against the live listings: that each tool is still listed, and that the skills name no listed tool the file
  leaves out. A rename is then one change in one repository.
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
   tooling, the config loader, `/health` under its own contract. Deployed 2026-11-17 to
   `authoring-ops-mcp.localdomain` (`--provision`, `--env`, then a deploy, which installs the systemd unit).
2. **Service probes.** Built: `/health` for the five, `tools/list` for all six, the services table, `status`.
3. **Subscribers and holdings findings.** Built, with `findings`.
4. **Skills and guidance.** Built here: the vendoring step, `list_skills` and `get_skill`, the instructions,
   and the drift findings. `tools-used.json` and its test are in authoring-skills, tagged `v0.1.0`; holdings-mcp
   no longer runs `tools-skills-use` (its PR #7, merged and deployed after this server was live).
5. **Portal.** Done: `authoring-ops-mcp.majerus.us` has its own Access application (self-hosted, with the
   others' policy and OAuth setting), and the portal lists the server as `suite`. Its four tools answer
   through the portal from Claude Code.
6. **Health contract fixes**, server by server, as each is next touched: terminology-mcp's `version`,
   `dirty` in corpus-mcp and terminology-mcp, then the optional fields.

## Open questions

- **Commit vs. GitHub `main`**: recommended no, for now. Branch and `dirty` already catch "not what main
  says", and the deploy age catches "hasn't moved in a while". What's missing is "main has moved on", which
  costs a token and a dependency on github.com. Revisit if a stale deploy ever goes unnoticed.
- **Who owns a holdings finding**: its `fix` is prose ("corpus-mcp for a book, quote-mcp for quotes"), so
  grouping by owner groups by sentence. A `repo` field beside it in `/api/checks` would fix that.
- **Dismissed holdings findings**: `/api/checks` counts them, so a check whose every finding was dismissed
  still shows here as one line. A count of undismissed findings in `/api/checks` would let it drop off.
- **`list_sets`**: `concept-dossier` names it without saying whose. quote-mcp and terminology-mcp both have
  one; `tools-used.json` puts it under terminology-mcp, from the tools named around it. Worth a word in the skill.
- **Instructions order**: answered. The portal put the front door's instructions first when it was added
  (2026-11-17); whether that holds as servers are added or renamed is worth a look then.
- **Tool budget**: what number should the portal total be held under? Set `tool_budget` in the suite config
  to get a finding when it's passed. Ways to trim zotero-mcp without a fork: `ZOTERO_MCP_TOOLSETS` upstream,
  the portal's per-tool toggles, and Code Mode.
- **Alerts**: dashboard only, or also a push (email, ntfy) when a service has been down for N minutes?
  Nothing watches this server either: if it's down, the dashboard is.
- **Concept Clusters**: it appears as a subscriber, and a finding about it names `concept-clusters` as the
  owner. Enough, or does it want a row?
