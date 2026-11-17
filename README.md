# authoring-ops-mcp

The front door to the authoring suite behind the Authoring Portal (`suite_` there). It has three jobs:

- **Routing.** Its MCP instructions tell an agent which server does what and where to start (holdings'
  `find_work` for anything the owner has). The portal shows them ahead of every other server's.
- **Health.** It polls every service each minute and answers whether the suite is working. Each finding says
  how bad it is and who owns the fix. A page at `/` shows the same to anyone; `/admin`, on the LAN, adds
  the errors behind each finding and the links to where fixes are made.
- **Skills.** It serves the [authoring skills](https://github.com/jmajerus/authoring-skills) to sessions that
  have none installed, and checks that every tool the skills call is still listed by its service.

It reads and reports, and changes nothing. See [PLAN.md](PLAN.md) for what is built and what isn't, and
[docs/health-contract.md](docs/health-contract.md) for what it reads from each server.

| | |
|---|---|
| Pages | http://authoring-ops-mcp.localdomain:8000/ (public) and `/admin` (LAN) |
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

The rest of the suite owns the facts. holdings-mcp runs the cross-service checks, because it holds the joins
between works; terminology-mcp keeps its subscribers. This server reads both and puts them beside the health of
every service, so one answer covers the suite. A source it can't read is a finding too.

## The suite

[suites/authoring.json](suites/authoring.json) names every service, its `/health` and MCP URLs, and its
repository; where the subscribers and checks are read; the routing lines in the instructions (`guidance`); the
tool budget; and the skills ref a release carries. The code names none of them. `OPS_SUITE` chooses the file.

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
| `/admin` | LAN | the same, with what each failing source said, the services' admin pages, the holdings worklist, and **Poll now** |
| `POST /admin/poll` | LAN | the admin page's button: poll now, then back to `/admin`. Refused from another site's page |
| `/health` | LAN | this server's own health, under the contract, with the skills ref it carries |
| `/api/status` | LAN | the last poll in full, as JSON |
| `POST /api/poll` | LAN | poll now (after a deploy, say), answering with the poll |
| `/mcp` | LAN, or Cloudflare Access | the four tools |

Neither page changes anything; the admin page links to pages that do. Through the tunnel, `/` answers without a
token, as holdings-mcp's library page does (a token, if sent, must still verify), `/mcp` needs a verified Access
token, and everything else is a 404. Whether `/` is actually reachable from outside is up to the Access
application: it covers the whole host now, so `/` asks for a sign-in like the rest. A bypass policy for `/` would
open it.

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

For the portal, the host needs its own Cloudflare Access application (self-hosted, with the same policy and
OAuth setting as the other servers). Without one, the tunnel passes requests through with no token, the server
answers 401, and the portal has no sign-in to follow.

## Interop runs

[docs/interop/](docs/interop/) keeps the whole-suite test runs: a piece written through all six servers, and
the findings it turned up, each with an owner.
