<#
.SYNOPSIS
  phantombot installer for Windows (preview).

.DESCRIPTION
  PowerShell parallel to install.sh. Usage:

    iwr -useb https://raw.githubusercontent.com/phantomyard/phantombot/main/install.ps1 | iex

  What it does:
    1. Detects arch (AMD64 -> x64, ARM64 -> arm64). Refuses anything else.
    2. Fetches the latest GitHub release tag.
    3. Downloads the matching phantombot-<tag>-windows-<arch>.exe + SHA256SUMS.
    4. Verifies the SHA256 (Get-FileHash). Refuses on mismatch.
    5. Runs Unblock-File so SmartScreen does not flag the downloaded binary
       (the Windows parallel to macOS quarantine-stripping in install.sh).
    6. Installs to %LOCALAPPDATA%\Programs\phantombot\phantombot.exe (per-user,
       no admin required).
    7. Adds the install dir to the USER PATH if it is not already there.
    8. Launches `phantombot init` to set up harness, persona, telegram, and the
       per-user Windows logon and periodic tasks.

  Override the install dir with $env:PHANTOMBOT_INSTALL_DIR.
  Skip the init TUI launch with $env:PHANTOMBOT_SKIP_TUI=1 (e.g. CI smoke tests).

  The install location matches where in-place self-update expects the running
  binary to live: the updater renames phantombot.exe aside to phantombot.exe.old
  in this same directory, so a stable, user-writable folder of its own is
  required - which is exactly what this installer creates.

  Refusal modes (intentional - bail fast):
    - unsupported arch
    - GitHub API did not return a parseable tag
    - SHA256SUMS has no entry for the asset
    - SHA256 mismatch
    - install dir not writable
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # keep Invoke-WebRequest quiet + fast

$Repo = 'phantomyard/phantombot'

function Fail([string]$msg) {
    [Console]::Error.WriteLine("phantombot: $msg")
    exit 1
}

# --- TLS ------------------------------------------------------------------
# Windows PowerShell 5.1 defaults to TLS 1.0/1.1 for .NET web calls; GitHub
# requires TLS 1.2+. Force it (best-effort; PowerShell 7 already negotiates it).
try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # Older/newer runtimes may not expose Tls12 on this enum; ignore and hope
    # the default negotiation is already modern enough.
}

# --- arch detection -------------------------------------------------------
# PROCESSOR_ARCHITECTURE is the shell's arch; on a 32-bit shell running on a
# 64-bit OS it reads x86 while PROCESSOR_ARCHITEW6432 carries the real one.
$rawArch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $rawArch = $env:PROCESSOR_ARCHITEW6432 }

switch ($rawArch) {
    'AMD64' { $arch = 'x64' }
    'ARM64' { $arch = 'arm64' }
    default {
        Fail "unsupported arch $rawArch (only AMD64 / ARM64 are released)"
    }
}

# --- install dir ----------------------------------------------------------
$InstallDir = $env:PHANTOMBOT_INSTALL_DIR
if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\phantombot'
}

try {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
} catch {
    Fail "could not create install dir $InstallDir : $($_.Exception.Message)"
}

# Prove writability up front (parallel to install.sh's -w check): touch and
# remove a probe file rather than trusting the mkdir succeeding.
$probe = Join-Path $InstallDir ('.write-probe-{0}' -f ([guid]::NewGuid().ToString('N')))
try {
    [IO.File]::WriteAllText($probe, 'x')
    Remove-Item -Force $probe
} catch {
    Fail "install dir $InstallDir is not writable"
}

# --- discover latest tag --------------------------------------------------
$apiUrl = "https://api.github.com/repos/$Repo/releases/latest"
$headers = @{ 'User-Agent' = 'phantombot-installer' }
if ($env:GITHUB_TOKEN) {
    $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)"
}

try {
    $release = Invoke-RestMethod -Uri $apiUrl -Headers $headers -UseBasicParsing
} catch {
    Fail "could not query $apiUrl : $($_.Exception.Message)"
}

# Guard the property access: under Set-StrictMode -Version Latest, reading a
# property the response object doesn't carry throws instead of yielding $null.
$tag = $null
if ($release.PSObject.Properties.Name -contains 'tag_name') {
    $tag = $release.tag_name
}
if (-not $tag) {
    Fail "could not parse latest tag from $apiUrl"
}

$asset      = "phantombot-$tag-windows-$arch.exe"
$binaryUrl  = "https://github.com/$Repo/releases/download/$tag/$asset"
$sumsUrl    = "https://github.com/$Repo/releases/download/$tag/SHA256SUMS"

# --- download + verify ----------------------------------------------------
$tmpBin = Join-Path ([IO.Path]::GetTempPath()) ("phantombot-{0}.exe" -f ([guid]::NewGuid().ToString('N')))

try {
    Write-Host "phantombot: downloading $asset"
    Invoke-WebRequest -Uri $binaryUrl -OutFile $tmpBin -Headers $headers -UseBasicParsing

    Write-Host 'phantombot: verifying SHA256'
    # GitHub serves release assets as application/octet-stream, so
    # Invoke-WebRequest returns .Content as a byte[] (NOT a string) for
    # SHA256SUMS. Decode explicitly; a naive string parse silently matches
    # nothing and every install fails with "no entry". Tolerate the string
    # case too, in case a runtime/proxy hands back decoded text.
    $sumsRaw = (Invoke-WebRequest -Uri $sumsUrl -Headers $headers -UseBasicParsing).Content
    if ($sumsRaw -is [byte[]]) {
        $sumsText = [Text.Encoding]::UTF8.GetString($sumsRaw)
    } else {
        $sumsText = [string]$sumsRaw
    }

    # SHA256SUMS lines are "<hex>  <asset>" (two spaces, text mode) or
    # "<hex> *<asset>" (binary mode). Match our asset, tolerate either.
    $expected = $null
    foreach ($line in ($sumsText -split "`n")) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        if ($trimmed -match '^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$') {
            if ($Matches[2] -eq $asset) { $expected = $Matches[1].ToLower(); break }
        }
    }
    if (-not $expected) {
        Fail "SHA256SUMS has no entry for $asset"
    }

    $actual = (Get-FileHash -Algorithm SHA256 -Path $tmpBin).Hash.ToLower()
    if ($expected -ne $actual) {
        Fail "SHA256 mismatch (expected $expected, got $actual) - refusing to install"
    }

    # --- SmartScreen prep -------------------------------------------------
    # Downloads carry a Zone.Identifier mark-of-the-web that trips SmartScreen
    # on first run. Unblock-File strips it - the Windows parallel to install.sh
    # clearing com.apple.quarantine on macOS.
    Unblock-File -Path $tmpBin

    # --- install ----------------------------------------------------------
    $dest = Join-Path $InstallDir 'phantombot.exe'
    Move-Item -Force -Path $tmpBin -Destination $dest
    Write-Host "phantombot: installed $tag to $dest"
} finally {
    if (Test-Path $tmpBin) { Remove-Item -Force -ErrorAction SilentlyContinue $tmpBin }
}

# --- PATH -----------------------------------------------------------------
# Add the install dir to the USER PATH (HKCU) if absent, so new shells find
# phantombot. No admin needed - user scope only. We also patch the current
# session so `phantombot` works immediately without opening a new window.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }

$onPath = $false
foreach ($p in ($userPath -split ';')) {
    if ($p.TrimEnd('\') -ieq $InstallDir.TrimEnd('\')) { $onPath = $true; break }
}

if (-not $onPath) {
    $newUserPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
    Write-Host "phantombot: added $InstallDir to your user PATH (open a new terminal to pick it up everywhere)"
}
# Make it usable in THIS session regardless.
if (($env:Path -split ';' | ForEach-Object { $_.TrimEnd('\') }) -notcontains $InstallDir.TrimEnd('\')) {
    $env:Path = "$($env:Path);$InstallDir"
}

# --- launch setup ---------------------------------------------------------
if ($env:PHANTOMBOT_SKIP_TUI) {
    Write-Host ''
    Write-Host 'next, run this to finish setup:'
    Write-Host '  phantombot init'
    Write-Host ''
    exit 0
}

Write-Host ''
Write-Host 'phantombot: launching setup wizard.'
Write-Host ''
& (Join-Path $InstallDir 'phantombot.exe') init
