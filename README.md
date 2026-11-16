# authoring-ops-mcp

Is the authoring suite healthy, and if not, where do I look?

One LAN dashboard and two read-only MCP tools over every server behind the Authoring Portal. It reads and
reports, and changes nothing. Each finding names the repository that owns the fix.

See [PLAN.md](PLAN.md) for what is built and what isn't, and [docs/health-contract.md](docs/health-contract.md)
for what it reads from each server.

## Run it

```
npm install
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
| `/mcp` | LAN, or Cloudflare Access | the tools `status` and `findings` |

## The suite

[suites/authoring.json](suites/authoring.json) names every service, its `/health` and MCP URLs, and its
repository. The code names none of them. `OPS_SUITE` chooses the file.

## Deploy

```
npm run deploy -- --provision   # once, after the container exists
npm run deploy -- --env         # ACCESS_TEAM_DOMAIN from .env
npm run deploy
```

On holdings-mcp's pattern, to `authoring-ops-mcp.localdomain`. Not yet run: the container doesn't exist.
