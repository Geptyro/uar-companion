# UAR Companion — working notes

## Changelog

Every user-visible change must include a `changelog/unreleased/*.md` entry in
the same commit as the change itself (frontmatter: `title`,
`type: feature|improvement|performance|fix`,
`area: uploads|presence|window|updates|packaging`, optional
`impact: major|minor` — body written for players, not developers; read
`changelog/unreleased/README.md` before writing one). The vocabulary is
`ENTRY_TYPES`/`ENTRY_AREAS` in `src/renderer/src/lib/changelog.ts`; a value
outside those lists does not fail the build, it silently falls back, so
`npm run changelog:check` is what catches it (`npm test` runs it too).

One file per change, named after the change (`auto-upload.md`), not after a
version or a date — `npm run release vX.Y.Z` is what moves entries into
`changelog/vX.Y.Z/` and stamps the date.

The format is deliberately the same as the website's, so an entry reads the same
in either repo, with two differences this app forces: `performance` is its own
type (it runs alongside a game), and body links must be absolute `https://` —
there is no router here to follow a relative one.

Purely internal work (refactors, test-only changes, dependency bumps) gets no
entry.

## Release

`npm run release vX.Y.Z` rolls up `changelog/unreleased/`, bumps the version,
commits, tags and pushes; the release workflow builds all three platforms from
the tag. A `major` entry's title becomes the release commit subject.
