# Interop runs

Whole-suite tests: one agent session writes a piece through all six servers behind the portal, and what goes
wrong becomes findings, each with the service that owns the fix. They started in holdings-mcp, when it was the
suite's front door, and moved here on 2026-11-17 (holdings-mcp's `docs/demo` and `docs/dev-briefs`, up to
`ce671b4`). The files are kept as they were, except paths to each other, which now point here.

| Run | Date | Files |
|---|---|---|
| The Chamber and the System | 2026-11-09 | `interoperability-essay.*` (the renders; the source is iasp-mcp's `demo/interoperability-essay.md`) |
| The Glass Office | 2026-11-13 | `glass-office.*` (source, bibliography, renders), [the brief](Interop%20test%202%20The%20Glass%20Office%20(2026-11-13).md), [the plan](Glass%20Office%20findings%20plan.md), and [the follow-up](glass-office-followup.md), with each finding's owner and status |
| Zero Spaces (a book review) | 2026-11-22 | `zero-spaces-review.*` (source and renders) and [the findings](zero-spaces-review-findings.md), with each finding's owner and status and a sketch of a book-review skill |

The `status` and `findings` tools now report much of what these runs found by hand: a service down or deployed
off main, a tool a skill calls that its service stopped listing, and the cross-service checks. A new run goes
here: the piece, its renders, and a findings table in the follow-up's form (finding, owner, status).

Finished pieces that show what a skill makes are kept with the skills instead, in authoring-skills'
`examples/`.
