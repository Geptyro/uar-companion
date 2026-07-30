# Changelog entries

One markdown file per user-visible change, committed in the same commit as the
change itself. `npm run release vX.Y.Z` moves the entries here into
`changelog/vX.Y.Z/`, stamps the release date, bumps the version, commits, tags
and pushes — the release workflow builds all three platforms from the tag. The
app renders everything under Changelog, and the sidebar counts releases newer
than the running build.

Same format as the website's changelog, so an entry reads the same in either
repo. All frontmatter fields required except `impact`; the body is written for
players, not developers:

```markdown
---
title: Short player-facing headline
type: improvement
area: uploads
---
One or two sentences on what changed and why a player cares. Markdown subset:
paragraphs, "- " lists, **bold**, `code`, [links](https://example.com) (https
only — the app has no router to follow a relative one).
```

- `type`: `feature` (new), `improvement` (existing thing got better),
  `performance` (it costs the machine less — the companion runs alongside a
  game, so this is its own category), `fix` (something wrong is now right).
- `area`: `uploads` | `presence` | `window` | `updates` | `packaging`.
- `impact` (optional): `major` = the release's headline, and the release
  commit takes its subject from that entry's title (rare — one per release);
  `minor` = nobody would notice unless told, listed compactly at the bottom of
  the release. Omit for everything in between.

A title with a colon in it may be quoted: `title: 'Fixed: the thing'`. Quoting
is optional either way — the value keeps everything after the first `:` — but a
title that both starts and ends with the same quote character it also contains
cannot be unwrapped, and keeps the outer pair in the headline.

`npm run changelog:check` lints every entry (`npm test` runs it too). Worth
running after writing one: the parser deliberately never fails a build over an
entry, so an off-schema `type`/`area` would otherwise file the change under the
wrong heading without a word.
