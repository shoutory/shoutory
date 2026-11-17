# Contributing

Thank you for helping. Security problems are reported privately, see [SECURITY.md](SECURITY.md).

## Setup

Use Node.js 26.13.0 and the pnpm version named in `package.json`, then `pnpm install --frozen-lockfile`. Dependencies
are pinned exactly, and a package must be at least 14 days old before we adopt it.

## Before you open a pull request

- Run `pnpm verify`. It must be green; a skipped check counts as a failure.
- Write the test first and watch it fail for the right reason. A test asserts behaviour through the public contract,
  once, at one level.
- Keep one behaviour per commit. Commit subjects are conventional: `type(scope): imperative summary`, with `!` for a
  breaking change, and the body says why.
- Do not add a dependency without an evaluation card in `docs/dependencies.md`.

## Contributor licence agreement

Outside contributors sign the contributor licence agreement before a pull request can merge. A hosted CLA app asks
for your signature on your first pull request.

## Code of conduct

Be respectful and assume good faith. Maintainers may remove comments or contributions that are abusive.
