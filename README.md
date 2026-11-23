# authoring-ops-mcp

The front door to the authoring suite behind the Authoring Portal (`suite_` there). It has three jobs:

- **Routing.** Its MCP instructions tell an agent which server does what and where to start (holdings'
  `find_work` for anything the owner has). The portal shows them ahead of every other server's.
- **Health.** It polls every service each minute and answers whether the suite is working. Each finding says
  how bad it is and who owns the fix. A page at `/` shows anyone how many need attention in each service; on
  the LAN each count opens the page that lists those findings, and `/admin` adds the errors.
- **Skills.** It serves the [authoring skills](https://github.com/jmajerus/authoring-skills) to sessions that
  have none installed, and checks that every tool the skills call is still listed by its service.

It reads and reports, and changes nothing. See [PLAN.md](PLAN.md) for what is built and what isn't, and
[docs/health-contract.md](docs/health-contract.md) for what it reads from each server.

| | |
|---|---|
| Pages | `https://authoring-ops.majerus.us/` (public); http://authoring-ops-mcp.localdomain:8000/admin (LAN) |
| MCP | `https://authoring-ops-mcp.majerus.us/mcp`, behind Cloudflare Access, added to the portal with the prefix `suite` |

## Tools

| Tool | What it answers |
|---|---|
| `status` | Every service: up or down and since when, version, deployed branch and commit, tool count. Each terminology subscriber's lag, the suite's tool total, the skills' ref, and the count of open findings |
| `findings` | What needs attention, worst and oldest first, each with a severity (`fail`: wrong now; `drift`: healing or waiting for a person), who owns the fix, and when it was first seen |
| `list_skills` | The skills this release carries: name, when to use each, its files |
| `get_skill` | One skill's `SKILL.md` or another of its files, as text to follow |

`list_skills` and `get_skill` are there only when the release carries skills. An agent with a skill installed
uses that copy instead.

## What it finds

| Finding | Severity | Read from |
|---|---|---|
| A service down, or up with no MCP tool listing | fail | each service's `/health` and `tools/list` |
| A service that says it can't reach one of its dependencies | fail | its `/health` |
| A deploy from a branch other than main, or from a checkout with uncommitted changes | drift | its `/health` (`deployed`) |
| A terminology subscriber that is blocked, behind for too long, or gone quiet | fail / drift | terminology-mcp's subscriber registry |
| A cross-service check that isn't passing, one line each, linked to the worklist | as the check says | holdings-mcp's `/api/checks` |
| A tool the skills call that its service no longer lists, or one they call that `tools-used.json` misses | fail / drift | the skills' `tools-used.json`, against each listing |
| More tools across the suite than `tool_budget`, when the suite config sets one | drift | the listings |
| A service's numbers that can't be read for five minutes | drift | its `stats` source |
| Commits on a fork's branch that the service doesn't run yet (after an hour), or a service running a commit that isn't on its branch | drift | GitHub, against what `deploy:fork` recorded |

The rest of the suite owns the facts. holdings-mcp runs the cross-service checks, because it holds the joins
between works; terminology-mcp keeps its subscribers. This server reads both and puts them beside the health of
every service, so one answer covers the suite. A source it can't read is a finding too.

## The suite

[suites/authoring.json](suites/authoring.json) names every service, its `/health` and MCP URLs, its
repository, its admin and public pages, a third party's project (`upstream`), and the fork it runs, if any
(`fork`: `{ repo, branch, deploy }`, where `deploy` says how `npm run deploy:fork` reaches it), and where
another service keeps its numbers (`stats`: `{ url, owner }`; zotero-mcp's are holdings-mcp's `/api/zotero/stats`); where the
subscribers and checks are read; the routing lines in the instructions (`guidance`); the tool budget; and the skills ref a release carries. The code names none of them. `OPS_SUITE` chooses the file.

Keep the guidance short: the portal joins every server's instructions and cuts the whole off at a length.

## Skills

The server serves a copy of authoring-skills from `./skills` (`OPS_SKILLS`) and never fetches one at run time.
`npm run skills` makes the copy at the ref the suite config pins; `--worktree` takes the checkout beside this
one as it is, for development. The deploy makes it at the pinned ref, so that ref must exist in that checkout.
To ship new skills, tag authoring-skills, change the ref in the suite config, and deploy.

The copy includes `tools-used.json`, the tools the skills call by service. Each poll compares it with what
every service lists, so a renamed or retired tool shows up as a finding before a skill trips over it.

## What it serves

| Path | Who | What |
|---|---|---|
| `/` | anyone | the public page: services, findings by owner, terminology subscribers, skills. No addresses, no error text, no links to anything writable |
| `/services/<name>` | anyone | one service's page: up or down, its version, its tools and which the skills call, its findings (summaries only), and, where another service keeps them, its numbers (for zotero-mcp, the library's items, collections, notes, and attachments from holdings-mcp's mirror; counts only, no library ID). The public page links here for a service with no public page of its own, such as zotero-mcp |
| `/favicon.svg` | anyone | the pages' icon: a heartbeat on deep teal, in the siblings' style |
| `/admin` | LAN | the same, with what each failing source said, the services' admin pages, the holdings worklist, and **Poll now** |
| `POST /admin/poll` | LAN | the admin page's button: poll now, then back to `/admin`. Only with a browser's word that it came from this server's page (`Origin` or `Sec-Fetch-Site`) |
| `/health` | LAN | this server's own health, under the contract, with the skills ref it carries |
| `/api/status` | LAN | the last poll in full, as JSON |
| `POST /api/poll` | LAN | poll now (after a deploy, say), answering with the poll. For curl and scripts; refused when a browser says another site sent it |
| `/mcp` | LAN, or Cloudflare Access | the four tools |

Neither page changes anything; the admin page links to pages that do. Through the tunnel, `/` answers without a
token, as holdings-mcp's library page does (a token, if sent, must still verify), `/mcp` needs a verified Access
token, and everything else is a 404. Like the other servers, this one has two hostnames:
`authoring-ops.majerus.us`, which no Access application covers, for the public page; and
`authoring-ops-mcp.majerus.us`, which the suite's MCP application covers whole (with managed OAuth for the
portal). Keep that application on the whole host: scoped to `/mcp`, it stops answering the OAuth discovery
addresses at the host's root (`/.well-known/oauth-protected-resource` and the rest), and MCP clients can't sign in.

The public page links each service's name to its own public page (`public` in the suite config), or, for one
with none, to its page here under `/services/`; `/admin` links it to the repository, and each deployed commit to
that commit. A service without `/health` (a third party) gets its version from what it reports when a client
connects for the tool listing.

For a service run from a fork, the server checks GitHub hourly: how many commits the running commit (the one
`deploy:fork` recorded; the branch's tip until there is one) is ahead of and behind upstream's latest release and
upstream's default branch, and how many commits on the branch aren't deployed yet. The public page, the service's
page, and `status` show it. Being behind upstream isn't a finding, since it isn't wrong; it's there for deciding
when to rebase before the next change. A deploy is noticed at the next poll. It needs no token (a handful of
requests an hour); `GITHUB_TOKEN`, if set, is sent.

A finding keeps its `summary` safe for the public page and puts what the failing source said (an error, a
reason) in `detail`, which `/admin` and the `findings` tool show.

## Run it

```
npm install
npm run skills -- --worktree   # copy the skills from ../authoring-skills as they are now
npm run status     # poll the suite once and print the answer
npm run serve      # the dashboard at http://localhost:8000/, MCP at /mcp
npm test
```

Needs Node 22 and a place on the LAN. No settings are required; [.env.example](.env.example) lists them.

## Deploy

```
npm run deploy -- --provision   # once, after the container exists: Node, the ops user, directories
npm run deploy -- --env         # ACCESS_TEAM_DOMAIN and OPS_POLL_SECONDS from .env
npm run deploy                  # build, test, carry the skills, install, restart, health-check
```

On holdings-mcp's pattern, to `authoring-ops-mcp.localdomain`: a release directory per deploy, rollback on a
failed health check, and the branch and commit recorded for `/health`. The deploy installs and enables the
systemd unit itself. `AUTHORING_DEPLOY_PASSWORD` in `.env` is the `authoring` login's.

### A service run from a fork

```
npm run deploy:fork -- zotero-mcp            # install the tip of the fork's branch, check it, record it
npm run deploy:fork -- zotero-mcp --commit <sha>
npm run deploy:fork -- zotero-mcp --adopt    # install nothing; record the commit it already runs
```

zotero-mcp is someone else's project, run from a fork (`jmajerus/zotero-mcp`, branch `lan`). The deploy lives
here, not in the fork, so the fork stays easy to rebase on upstream. It pip-installs the branch's tip, pinned to
its commit, into the service's virtualenv over SSH as root (the LXC must take this machine's key), restarts the
unit, and lists the tools: if the listing doesn't answer or drops a tool the skills call, the previous commit goes
back. The commit is recorded in `forks.json` beside `deployed.json` on this server's LXC, which the fork check
reads each poll. The service's `fork.deploy` in the suite config says where: `ssh`, `venv`, `package`, `unit`.

For the portal, the host needs its own Cloudflare Access application (self-hosted, with the same policy and
OAuth setting as the other servers). Without one, the tunnel passes requests through with no token, the server
answers 401, and the portal has no sign-in to follow.

## Interop runs

[docs/interop/](docs/interop/) keeps the whole-suite test runs: a piece written through all six servers, and
the findings it turned up, each with an owner.
