# Zero Spaces review: findings

Interop run 3, 2026-11-22. One Claude session (claude.ai, through the portal) wrote a book review of Gabrielle
Collet's *Zero Spaces* for *The Cat's Alley*, following the portal-article skill (authoring-skills v0.1.0,
`efe9abb`). The piece is [`zero-spaces-review.md`](zero-spaces-review.md); its renders are beside it.

**Result.** About 1,900 words, 18 quotes saved and verified (ids 875–892, tagged `project:zero-spaces-review`),
three books filed to `Corpus MCP/Staging` and pinned (`collet2018zero`, `lederach2005moral`,
`floridi2015onlife`, all `matched`), and Ghost, Markdown, HTML and PDF renders. Every quote matched its saved
text in the final render, and the bibliography resolved all three keys from Zotero.

The suite carried the hard part: every quoted word traces to a page, and its checks caught real mistakes. Most
of the friction came from source text and metadata, and from places where the tools and the skill disagree.

## Findings

| # | Finding | Owner | Status |
|---|---|---|---|
| 1 | PDF text drops ligatures ("Te" for "The"; also fi, ft), so exact matching rejects correct quotes | corpus-mcp | open |
| 2 | A PDF with no page labels gets `page_label` = file position; *Zero Spaces* prints one lower | corpus-mcp | open |
| 3 | The skill allows partial quotes as a warning; `validate_markdown` errors on partial run-in quotes | iasp-mcp + authoring-skills | open |
| 4 | Two quote markers before one paragraph (first draft only): the first is checked against an empty passage | iasp-mcp + authoring-skills | open |
| 5 | Quotes saved before and after filing land on two works (`quote:762`, 765); `cite_quote` still warns "not filed" after the match | quote-mcp (holdings-mcp check) | open |
| 6 | Ghost render gives the note after a quoted paragraph that quote's `data-quote-*` attributes | iasp-mcp | open |
| 7 | Wrong or thin Calibre metadata passes straight into the reference list | corpus-mcp + a person | open |
| 8 | A 255-page PDF with no outline is costly to read through `read_book` | corpus-mcp | open |
| 9 | Render takes only inline Markdown or a server path; output names can collide with the source | iasp-mcp | open |
| 10 | corpus-mcp stopped answering `/health` for a few minutes mid-session | corpus-mcp | observed |
| 11 | No skill fits a book review | authoring-skills | proposed (sketch below) |
| 12 | Gaps outside the suite: no fact-check helper, no Ghost publish step | suite (new) | idea |
| 13 | Partial-sentence citations saved for the review appear on the public quotes page beside collected passages | quote-mcp + authoring-skills | open |

### 1. Dropped ligatures in PDF text (corpus-mcp)

The indexed text of *Zero Spaces* (`main:14`) loses the "Th" ligature throughout ("Te subject", "Tis
non-tangible") and also "fi" and "ft" ("afer", "crafsmanship"). `add_quote` compares words exactly, so the
correct reading "This non-tangible …" was refused with "Not found". The session worked around it by choosing
passages without those letters, which narrowed what the review could quote.

Possible fixes: repair the common dropped ligatures at index time; or match ligature-tolerantly and store the
corrected reading with a flag; and report text quality in `get_book_outline` so the problem shows before
quoting starts.

### 2. PDF page labels off by one (corpus-mcp)

The PDF carries no page-label metadata, so `page_label` equals `file_page`. The printed number is one lower
throughout (contents gives the Introduction at 15; it is file page 16). The review cites printed pages, which
gave 13 `quote-locator-differs` warnings in validation and render. False warnings teach users to ignore real
ones.

Possible fixes: a per-book page offset a person can pin, like `pin_citekey`; or infer the offset from numbers
printed on chapter-opening pages and the printed contents.

The renders carry the stored locator too. In the HTML and Ghost files, each quote's machine-readable
`data-quote-locator` gives the file page (quote 875: `p. 17`) while the visible citation gives the printed
page (16). Anything that reads those attributes as provenance is sent one page high. Once quotes 875–887 and
891–892 have the right printed pages, the review should be rendered again.

### 3. Partial quotes: skill and validator disagree (iasp-mcp, authoring-skills)

portal-article step 7 says `text: "excerpt"` is a warning when the draft quotes a run of the saved words. In
this run `validate_markdown` returned `quote-text-differs` errors for run-in paragraphs that quoted part of a
saved quote (ids 875, 886, 879). The fix was to quote each saved text whole. Either allow excerpts in run-ins
with a warning, or have the skill say to save exactly the words that will be quoted.

### 4. Stacked quote markers (iasp-mcp, authoring-skills)

In the first draft sent to `validate_markdown`, `<!-- quote 891 -->` and `<!-- quote 892 -->` sat on
consecutive lines before one paragraph that quoted both:

```
<!-- quote 891 -->
<!-- quote 892 -->
The results are … "are said to date back to around 4500 B.C.E." [@collet2018zero, p. 102] … Dante appears
as "having become literally blind" [@collet2018zero, p. 113] …
```

891 was checked against nothing (`quote-text-differs` with an empty draft passage, and `quote-citation-missing`),
and 892 took the paragraph. The committed source splits them into two paragraphs, one marker each, so it no
longer shows the problem. Either accept several ids in one
marker (`<!-- quote 891 892 -->`) or say in the skill: one marker per paragraph.

### 5. One book, two quote-store works (quote-mcp)

Quotes 875–890 were saved while *Zero Spaces* was unfiled and sit on work 762 (`unmatched`). After filing and
pinning, quotes 891–892 went to work 765 (`zotero`, `W7SF3AIQ`). The render's provenance still gives
`workKey: quote:762` for the earlier quotes, and `cite_quote` kept warning "This work isn't filed in Zotero
yet" after `pin_citekey` returned `matched`. The same likely holds for Lederach and *The Onlife Manifesto*.
When a pin matches a work, its earlier quotes should move to the matched work. holdings-mcp's
`one-work-per-exact-key` check may already be flagging it.

### 6. Marker attributes leak into the next block (iasp-mcp)

In the Ghost render, the `.note .scope` div after the last quoted paragraph carries
`data-quote-id="884" data-citekey="collet2018zero" data-work-key="quote:762" data-quote-locator="p. 242"`
(`zero-spaces-review.ghost.md`, line 103). A consumer that reads these attributes as provenance would tie the
scope note to Collet's quotation. The HTML render's scope note is clean, so the leak is in the Ghost
exporter. Marker state should reset after the block it marks. The committed Ghost file is kept as rendered,
as the reproduction; render again once the fix lands.

### 7. Metadata passes through (corpus-mcp, a person)

The skill says to file books as given, so these errors reach the reference list:

- *Zero Spaces*: Calibre gives 2018 and no publisher. The PDF's cover sheet says December 2014 (Atropos Press,
  New York and Dresden); its copyright line is unreadable in the text. The review renders as "Collet 2018".
- *The Onlife Manifesto*: Floridi is listed as author; he is the editor. The quoted chapter is Nicole
  Dewandre's, and the session didn't set `chapter_author` on quote 890 (its miss).
- Lederach: Calibre has no ISBN; the book prints 9780195174540.

`cite_passage` already offers a printed year when Calibre has none. It could also flag a Calibre year that
disagrees with the book. Editors and chapter authors need a path from Calibre to Zotero.

### 8. Reading a long PDF (corpus-mcp)

*Zero Spaces* has no PDF outline, though its printed contents (file pages 5–7) were easy to read. At 40,000
characters per `read_book` call, reading the whole book costs about 16 calls and much of a session's context.
The session read Parts I and III, the play, and the chapters on collaborative art and sound, and only sampled
Part II; the review says so in a scope note. An outline built from the printed contents, or a skim mode
(headings and first sentences by page range), would help.

### 9. Getting a draft to the renderer (iasp-mcp)

The iasp server can't open the session's files, so the 14 KB source was pasted inline twice. The session also
saved the rendered `md` under the source's name and overwrote it (its own mistake). An upload step, or
rendering a draft stored server-side, would remove the pasting; a default `-rendered.md` name would prevent
the collision.

### 10. corpus-mcp outage (corpus-mcp)

At 14:31Z two `add_quote` calls failed with "corpus-mcp unreachable … timeout", and `findings` showed
`down:corpus-mcp`. A search a minute later succeeded. The session had just made several large `read_book`
calls (20,000–40,000 characters); whether they were the cause is not known. Worth checking corpus-mcp's logs
for that minute. A short retry inside `add_quote` would have hidden it.

### 11. A book-review skill (authoring-skills)

portal-article is built for an essay: a topic the library can carry, 900–1,200 words, one footnote per quote,
one question before saving. A review is book-first: read one work through, judge it, compare it with others.
A sketch for authoring-skills:

1. **Find and plan.** `find_work`, then `get_book_outline`; when there is no outline, read the printed contents.
   Plan the reading against the context budget, and decide up front what will only be sampled.
2. **Read in passes**, keeping notes with `file_page` for each quotable passage, each claim to check, and each
   error found. Never quote from a search snippet.
3. **Test the book against its title.** `search_corpus` within the book for its key terms to see where it treats
   its subject and where it only promises it.
4. **Find comparisons.** `search_corpus` across the library for the book's central concepts, plus `get_concept`
   for related and opposite concepts.
5. **One question, or none.** When the person has given broad permission ("use the full suite"), save and file
   without asking, and say so in the handover.
6. **Secure quotes** as portal-article step 4, checking the printed page against the file page, and setting
   `chapter_author` for edited volumes. Save exactly the words the review quotes; they are citations, not
   additions to the collection (finding 13).
7. **File and pin** as portal-article step 5.
8. **Write.** A bibliographic line; what the book is; what it does well; where it fails, with quotes; the
   comparison; a verdict; a `.note .scope` saying what was read in full and what was sampled. 1,200–2,000
   words. One footnote per source rather than per quote.
9. **List claims to check:** every fact from general knowledge goes in the disclosure note and the handover,
   with a web check where the session has search.
10. **Validate, render, hand over** as portal-article steps 7–9, with `ghost` first when the piece is for the
    blog. Report the citations saved and their project tag, and propose none of them for the collection
    (finding 13).

It would be served from here once authoring-skills is tagged and the ref in `suites/authoring.json` changes.

### 12. Outside the suite

- No way to verify general-knowledge facts. A web search didn't confirm the source of the Deleuze epigraph,
  so it is flagged in the review's disclosure.
- No step that publishes to Ghost as a draft (Ghost Admin API).

### 13. Citations on the public quotes page (quote-mcp, authoring-skills)

Ten of the 18 quotes saved for the review are parts of sentences: 875, 876, 878, 883, 885, 886, 887, 890,
891 and 892. The public quotes page shows them beside passages John chose to keep. Three of them (887, 891,
892) were saved only as evidence of the book's errors.

The line to draw is purpose, not length. A quote saved because a piece cites it is a **citation**; a quote
the owner chose to keep for its own sake is a **collected passage**. Saving full sentences instead would not
help: a full sentence chosen for one point in one review looks like a passage worth keeping, and deciding
that is the owner's judgment, not an agent's. Neither should a skill offer a shortlist for promotion: a
shortlist is a filter, so the agent would still be choosing what is interesting.

Proposed:

- **quote-mcp:** keep agent-saved quotes off the public page until the owner promotes one. The store already
  records them: each has `generative: true`, an origin of kind `agent` with its request id, and a G label
  (G875 and so on). Promotion is a deliberate act by a person.
- **quote-mcp:** exclude partial sentences from anything automatic (the public page, suggestions), whoever
  saved them, but let the owner promote one by hand; a passage worth keeping is not always a complete
  sentence. Detect fragments from the source, not from the quote's shape: a verified quote is anchored to the
  book text, so the store knows whether it begins at a sentence start and ends at a sentence end. Shape
  misleads: 879 ("Hence, eradicating …") opens with a capital and ends with a period but has no main verb,
  and 883 ("collaboration consists in generating possibility.") is a whole clause that opens in lowercase.
  Only paper-book quotes, with no text to check against, need a shape-based guess.
- **authoring-skills:** a skill saves the words a piece quotes as citations, says so in its handover, and
  proposes none of them for the collection. portal-article and the book-review sketch (finding 11) should
  say this. quote-harvest is different: there the owner has asked for proposals, and proposing is the task.

This replaces the "save the full sentence and quote part of it" fix suggested during the session. Fixing
findings 1 and 3 still matters: they are what pushed the session toward saving exact runs in the first place.

## What worked

- `find_work` gave the book's form, the next tools, and why it couldn't be cited yet, in one call.
- `search_corpus` with `advanced` inside the book ("Bishop OR Kester OR Rancière") showed that collaboration,
  the title's subject, is treated seriously on about five pages (204–208). That became the review's argument.
- `search_corpus` across the library found the comparison works: Lederach's *The Moral Imagination* and the
  Arendt passage in *The Onlife Manifesto*.
- `add_quote` caught a wrong file page (83, not 84) and listed the closest passages on a mismatch;
  `request_id` kept retries from saving twice.
- `validate_markdown` caught stacked markers and partial run-in quotes; `render_document` repeated the
  comparison on the output.
- Filing then `pin_citekey` matched all three books by Calibre UUID, and the reference list built from Zotero.
- `findings` named the corpus-mcp outage at once.

## Needs a person

- Zotero staging: give *Zero Spaces* (`W7SF3AIQ`) its date and publisher, and *The Onlife Manifesto*
  (`RSQW6CWM`) Floridi as editor; then re-render the review.
- Calibre: the same for `main:14` and `main:1160`, and the ISBN for `main:1396`.
- Until finding 13 lands, the ten partial-sentence quotes (875, 876, 878, 883, 885, 886, 887, 890, 891, 892)
  show on the public quotes page; hide them there if that shouldn't wait. Deleting them would break the
  review's quote markers.
- Confirm the facts the review takes from general knowledge (listed in its disclosure note) before it is
  published.
- Copy `zero-spaces-review.pdf` from `/var/lib/iasp-mcp/renders/zero-spaces-review/` on the iasp-mcp server into
  this directory.
