# Contributing to Phantombot

Thanks for helping. Bug reports, docs fixes, and code are all welcome.

## Quick start

You need [Bun](https://bun.sh) 1.x and git.

```bash
git clone https://github.com/phantomyard/phantombot.git
cd phantombot
bun install
bun tsc --noEmit   # typecheck
bun test           # full suite
bun run build      # compiled binary in dist/
```

Run a single file with `bun test tests/<name>.test.ts`, and run the CLI from
source with `bun src/index.ts <command>`.

> [!IMPORTANT]
> Tests must never touch your real home directory or a live Phantombot
> install. Point `HOME` and the XDG directories at a temporary directory in
> every test that reads or writes state. See the
> [testing invariants](docs/contributing/invariants/testing.md).

## Where to start

- Issues labelled
  [`good first issue`](https://github.com/phantomyard/phantombot/labels/good%20first%20issue)
  are small and self-contained.
- [`docs/contributing/repo-layout.md`](docs/contributing/repo-layout.md) maps
  the source tree.
- [`docs/contributing/adding-a-harness.md`](docs/contributing/adding-a-harness.md)
  walks through adding a new AI harness.
- [`AGENTS.md`](AGENTS.md) is the full contributor guide. Read the rules that
  cover the area you are changing before opening a pull request. Each one
  records a real incident.

## Pull requests

1. Branch from `main` and keep each pull request to one change.
2. Add or update tests. A bug fix should come with a test that fails without
   the fix.
3. Update `README.md` and the docs in the same pull request when you change
   anything a user can see: a command, a flag, a file location, or a default.
4. Make sure `bun tsc --noEmit` and `bun test` pass. CI also runs Windows and
   sandbox suites.
5. Write the title as `type(scope): summary`, for example
   `fix(telegram): retry on 429`. Types in use: `feat`, `fix`, `docs`,
   `test`, `refactor`, `release`.

Every merge to `main` publishes a prerelease. Maintainers promote releases to
the stable channel by hand, so a merged change reaches stable users later.

A maintainer review is needed to merge. Review findings are fixed in
the pull request itself; nothing is deferred to follow-up issues.

## Reporting bugs and security issues

- Bugs and feature ideas: [open an issue](https://github.com/phantomyard/phantombot/issues/new/choose).
  Include `phantombot --version` and the relevant part of `phantombot doctor`.
- Security vulnerabilities: please don't open a public issue. See
  [`SECURITY.md`](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
