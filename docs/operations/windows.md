# Run Phantombot on Windows

Windows x64 and arm64 releases are published as signed executables. Install in
Windows PowerShell:

```powershell
iex ((iwr -useb https://raw.githubusercontent.com/phantomyard/phantombot/main/install.ps1).Content.TrimStart([char]0xFEFF))
```

The BOM trim is required for Windows PowerShell 5.1. The installer detects the
architecture, verifies `SHA256SUMS`, unblocks the file, installs it below
`%LOCALAPPDATA%\Programs\phantombot`, updates the user PATH, and opens setup.

Verify a downloaded binary manually with:

```powershell
Get-AuthenticodeSignature .\phantombot-v1.1.N-windows-x64.exe
```

SmartScreen may still warn while the signing certificate builds reputation.
Use the signed release from the Phantomyard repository and verify its checksum
before choosing **More info → Run anyway**.

`phantombot install` creates per-persona jobs under `\Phantombot\` for the
daemon, heartbeat, and scheduler tick. Interactive mode runs while the user is
logged in. Logged-off mode stores the Windows credential with Task Scheduler;
Phantombot keeps only the selected mode and, when chosen, a reusable password
inside the persona vault.

```powershell
phantombot install
phantombot start
phantombot stop
phantombot restart
phantombot logs --no-follow
```

If all scheduled jobs are removed, nothing remains to self-heal. Log in and run
`phantombot install` again. Partial damage is repaired by the heartbeat.

Windows uses the same home-relative XDG data layout as other platforms. The
persona identity receives an owner-only ACL because it is also the root of the
vault encryption key.
