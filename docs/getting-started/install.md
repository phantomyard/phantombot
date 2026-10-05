# Install Phantombot

Released binaries include the native harness and do not require Bun, Node.js,
or a separate Pi installation.

## Linux and macOS

```bash
curl -fsSL https://raw.githubusercontent.com/phantomyard/phantombot/main/install.sh | sh
```

The installer selects the host architecture, downloads the latest stable
release and `SHA256SUMS`, verifies the binary, opens first-run setup, and
installs the host service when setup completes.

On macOS, use the installer rather than copying a binary manually. It handles
the quarantine and ad-hoc signing steps needed for a cross-compiled release.
If macOS repeatedly asks for permissions after updates, follow
[macOS permissions](../operations/macos-permissions.md).

## Windows

Open Windows PowerShell and run:

```powershell
iex ((iwr -useb https://raw.githubusercontent.com/phantomyard/phantombot/main/install.ps1).Content.TrimStart([char]0xFEFF))
```

The installer supports x64 and arm64, verifies the checksum, adds the binary
directory to the user PATH, and uses Task Scheduler for background services.
See [Windows](../operations/windows.md) for SmartScreen and service recovery.

## Build from source

Use Bun when contributing or embedding the engine:

```bash
git clone https://github.com/phantomyard/phantombot.git
cd phantombot
bun install
bun tsc --noEmit
bun test
bun run build
```

The Linux x64 release target is deliberately `bun-linux-x64-baseline` so it
runs on hosts without AVX2. Contributors should read [AGENTS.md](../../AGENTS.md)
before changing build or release behavior.

Next: [complete the first run](first-run.md).
