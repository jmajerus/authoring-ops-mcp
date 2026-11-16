# The health contract

What authoring-ops-mcp reads from each first-party server's `GET /health`. It was written from what the
five servers returned on 2026-11-16, so most of it is already true. This server's own `/health` follows it.

```json
{
  "ok": true,
  "service": "corpus-mcp",
  "version": "0.2.0",
  "deployed": { "branch": "main", "commit": "d23c9dcf28e9055f905c4902d1a37912a7d78019", "at": "2026-11-16T16:29:26.718Z", "dirty": false },
  "dependencies": [ { "name": "zotero", "ok": true } ],
  "admin": "http://corpus-mcp.localdomain:8000/admin"
}
```

## Rules

- `/health` answers on the LAN without auth, in well under five seconds (the dashboard gives up after five).
- A 200 with `ok` not `false` means up. Anything else (no answer, another status, `ok: false`) means down.
- A server may send any other fields. The dashboard ignores what it doesn't know.

## Fields

| Field | Today | Read as |
|---|---|---|
| `ok` | all five | up or down |
| `version` | all five | the software's version, shown as sent |
| `deployed.branch` | all five | a finding when it isn't `main` |
| `deployed.commit` | all five, as a full SHA | shown as seven characters, linked to the repository |
| `deployed.at` | all five | "deployed N days ago" |
| `deployed.dirty` | holdings-mcp, quote-mcp, iasp-mcp | a finding when `true`: the commit doesn't say what is running |
| `service` | none | new and optional; the config already names each service |
| `dependencies` | none | new and optional: `[{ name, ok }]`, the server's own view of what it relies on. A finding for each that is not ok |
| `admin` | none | new and optional: a link on the service's row, overriding the config's |

## Where the servers differ today

- **terminology-mcp's `version` is its changelog head** (345), not its software version. The dashboard shows
  345 in the version column. Fix in terminology-mcp: send the software version as `version` and keep the head
  under another name (the subscriber registry already calls it `head`).
- **`checks` is taken.** holdings-mcp's `/health` has `checks` as a summary object (`{ ok, drift, fail, … }`), so
  the new list of dependencies is called `dependencies`, not `checks` as PLAN.md first had it.
- **corpus-mcp and terminology-mcp send no `dirty`.** Without it, an unclean deploy can't be seen.
- **zotero-mcp has no `/health`** (third party). Its tool listing is its sign of life, asked every poll.
