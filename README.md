# authoring-ops-mcp

Is the authoring suite healthy, and if not, where do I look?

The front door to the suite behind the Authoring Portal: one LAN dashboard and four read-only MCP tools. Its
instructions tell an agent which server does what, its tools say whether the suite is working, and it serves
the authoring skills to sessions that have none installed. It reads and reports, and changes nothing. Each
finding names who owns the fix.

See [PLAN.md](PLAN.md) for what is built and what isn't, and [docs/health-contract.md](docs/health-contract.md)
for what it reads from each server.

## Run it

```
npm install
npm run skills -- --worktree   # copy the skills from ../authoring-skills as they are now
npm run status     # poll the suite once and print the answer
npm run serve      # the dashboard at http://localhost:8000/, MCP at /mcp
npm test
```

Needs Node 22 and a place on the LAN. No settings are required; [.env.example](.env.example) lists them.

## What it serves

| Path | Who | What |
|---|---|---|
| `/` | LAN | the dashboard: services, findings by owner, terminology subscribers |
| `/health` | LAN | this server's own health, under the contract |
| `/api/status` | LAN | the last poll in full, as JSON |
| `POST /api/poll` | LAN | poll now (after a deploy, say); it still only reads |
| `/mcp` | LAN, or Cloudflare Access | the tools `status`, `findings`, `list_skills`, and `get_skill` (`suite_…` through the portal) |

## The suite

[suites/authoring.json](suites/authoring.json) names every service, its `/health` and MCP URLs, and its
repository, with the guidance an agent is given and the skills ref a release carries. The code names none of
them. `OPS_SUITE` chooses the file.

## Skills

The server serves a copy of [authoring-skills](https://github.com/jmajerus/authoring-skills) from `./skills`,
and never fetches one at run time. `npm run skills` makes the copy at the ref in the suite config;
`--worktree` takes the checkout as it is, for development. The deploy makes it at the pinned ref, so that ref
must exist in the checkout beside this one.

## Deploy

```
npm run deploy -- --provision   # once, after the container exists
npm run deploy -- --env         # ACCESS_TEAM_DOMAIN from .env
npm run deploy
```

On holdings-mcp's pattern, to `authoring-ops-mcp.localdomain`. Not yet run: the container doesn't exist, and
authoring-skills has no `v0.1.0` tag yet.
