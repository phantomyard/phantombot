# Update Phantombot

```bash
phantombot update --check
phantombot update
phantombot update --force --restart
```

Updates download to a temporary file, verify the published SHA-256 checksum,
and atomically replace the live binary. The platform service is restarted only
when requested or when the calling surface explicitly performs that action.

## Stable and preview rings

Every functional merge to `main` produces a GitHub prerelease. Preview hosts
can install it immediately. Stable hosts use GitHub's latest stable release and
see a build only after a human promotes the already-published prerelease.

```toml
update_channel = "preview" # default is "stable"
```

`PHANTOMBOT_UPDATE_CHANNEL` overrides the file setting. Invalid values fall
back to stable. `phantombot doctor` reports the active ring and version.

Promotion does not rebuild: it flips the prerelease flag on the exact artifacts
that soaked on preview. To roll a preview host back, switch it to stable and run
`phantombot update`; version comparison is based on equality, so installing a
lower stable version is supported.

Documentation-only merges do not build binaries or create releases. See the
workflow comments for the conservative path classification.
