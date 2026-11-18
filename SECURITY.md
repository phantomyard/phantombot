# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/phantomyard/phantombot/security/advisories/new).
Don't open a public issue.

Include the Phantombot version (`phantombot --version`), your operating
system, and steps to reproduce. We will acknowledge the report, keep you
updated, and credit you in the advisory unless you prefer not to be named.

## Supported versions

Fixes ship in the latest release. Run `phantombot update` to stay current.

## Scope

The trust model is described in
[`docs/concepts/security-and-trust.md`](docs/concepts/security-and-trust.md)
and the sandbox contract in
[`docs/reference/bounded-security.md`](docs/reference/bounded-security.md).
Ways to make an untrusted input (email, webhook, bridge message, scheduled
task wake) act with owner authority, escape the sandbox, or read another
persona's vault are in scope.
