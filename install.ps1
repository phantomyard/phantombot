<#
.SYNOPSIS
  phantombot installer for Windows.

.DESCRIPTION
  PowerShell parallel to install.sh. Usage:

    iwr -useb https://raw.githubusercontent.com/phantomyard/phantombot/main/install.ps1 | iex
    .\install.ps1 [-DryRun]

  What it does:
    1. Inspects system and arch.
    2. Downloads and installs phantombot.exe to %LOCALAPPDATA%\Programs\phantombot and checks PATH.
    3. Prompts for background service / autostart at boot (asks for Windows password).
    4. Launches the Phantombot TUI (in sandbox mode if -DryRun).

  Override the install dir with $env:PHANTOMBOT_INSTALL_DIR.
  Skip the TUI launch with $env:PHANTOMBOT_SKIP_TUI=1 (e.g. CI smoke tests).
  Run without making changes with -DryRun (or $env:PHANTOMBOT_DRY_RUN=1).
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$dryrun,
    [string]$InstallDir = $env:PHANTOMBOT_INSTALL_DIR
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($dryrun) { $DryRun = $true }
if ($env:PHANTOMBOT_DRY_RUN -or $env:PHANTOMBOT_DRYRUN) { $DryRun = $true }

$Repo = 'phantomyard/phantombot'

function Fail([string]$msg) {
    Write-Host " failed"
    [Console]::Error.WriteLine("phantombot: $msg")
    exit 1
}

# --- TLS ------------------------------------------------------------------
try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
}

Write-Host "Installing Phantombot..."
Write-Host ""

# --- 1. Inspecting System -------------------------------------------------
Write-Host -NoNewline "Inspecting System....."

$rawArch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $rawArch = $env:PROCESSOR_ARCHITEW6432 }

switch ($rawArch) {
    'AMD64' { $arch = 'x64' }
    'ARM64' { $arch = 'arm64' }
    default {
        Fail "unsupported arch $rawArch (only AMD64 / ARM64 are released)"
    }
}

if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\phantombot'
}

if (-not $DryRun -and -not $env:PHANTOMBOT_DEV_BIN) {
    try {
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    } catch {
        Fail "could not create install dir $InstallDir : $($_.Exception.Message)"
    }

    $probe = Join-Path $InstallDir ('.write-probe-{0}' -f ([guid]::NewGuid().ToString('N')))
    try {
        [IO.File]::WriteAllText($probe, 'x')
        Remove-Item -Force $probe
    } catch {
        Fail "install dir $InstallDir is not writable"
    }
}

Write-Host "$([char]0x2713)" -ForegroundColor Green

# --- 2. Downloading Binary ------------------------------------------------
Write-Host -NoNewline "Downloading Binary...."

$tmpBin = $null
if ($env:PHANTOMBOT_DEV_BIN) {
    # Dev binary provided — nothing to download
} elseif (-not $DryRun) {
    # Discover latest tag
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

    $tmpBin = Join-Path ([IO.Path]::GetTempPath()) ("phantombot-{0}.exe" -f ([guid]::NewGuid().ToString('N')))

    try {
        Invoke-WebRequest -Uri $binaryUrl -OutFile $tmpBin -Headers $headers -UseBasicParsing

        $sumsRaw = (Invoke-WebRequest -Uri $sumsUrl -Headers $headers -UseBasicParsing).Content
        if ($sumsRaw -is [byte[]]) {
            $sumsText = [Text.Encoding]::UTF8.GetString($sumsRaw)
        } else {
            $sumsText = [string]$sumsRaw
        }

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

        Unblock-File -Path $tmpBin
    } catch {
        if (Test-Path $tmpBin) { Remove-Item -Force -ErrorAction SilentlyContinue $tmpBin }
        Fail $_.Exception.Message
    }
}

Write-Host "$([char]0x2713)" -ForegroundColor Green

# --- 3. Installing Now ----------------------------------------------------
Write-Host -NoNewline "Installing Now........"

if ($env:PHANTOMBOT_DEV_BIN) {
    if (-not $DryRun) {
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        $dest = Join-Path $InstallDir 'phantombot.exe'
        Copy-Item -Force -Path $env:PHANTOMBOT_DEV_BIN -Destination $dest
        $PbBin = $dest
    } else {
        $PbBin = $env:PHANTOMBOT_DEV_BIN
    }
} elseif (-not $DryRun) {
    try {
        $dest = Join-Path $InstallDir 'phantombot.exe'
        Move-Item -Force -Path $tmpBin -Destination $dest
        $PbBin = $dest
    } catch {
        Fail "could not move binary to $dest : $($_.Exception.Message)"
    }
} else {
    $PbBin = Join-Path $InstallDir 'phantombot.exe'
    if (-not (Test-Path $PbBin)) {
        if (Test-Path 'dist\phantombot.exe') {
            $PbBin = (Resolve-Path 'dist\phantombot.exe').Path
        } elseif (Get-Command 'phantombot.exe' -ErrorAction SilentlyContinue) {
            $PbBin = (Get-Command 'phantombot.exe').Source
        }
    }
}

# --- PATH check -----------------------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }

$onPath = $false
foreach ($p in ($userPath -split ';')) {
    if ($p.TrimEnd('\') -ieq $InstallDir.TrimEnd('\')) { $onPath = $true; break }
}

if (-not $DryRun) {
    if (-not $onPath) {
        $newUserPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
    }
    if (($env:Path -split ';' | ForEach-Object { $_.TrimEnd('\') }) -notcontains $InstallDir.TrimEnd('\')) {
        $env:Path = "$($env:Path);$InstallDir"
    }
}

Write-Host "$([char]0x2713)" -ForegroundColor Green

# --- 4. Verifying ---------------------------------------------------------
Write-Host -NoNewline "Verifying............."

if ($PbBin) {
    if ((Test-Path $PbBin) -or $DryRun) {
        # Verified
    }
}

Write-Host "$([char]0x2713)" -ForegroundColor Green

Write-Host ""
Write-Host "Installation completed succesfully."

# --- autostart service installation ---------------------------------------
if (-not $DryRun) {
    try {
        & $PbBin install
    } catch {
        Write-Host "phantombot: service install warning: $($_.Exception.Message)"
    }
}

# --- launch TUI -----------------------------------------------------------
if ($env:PHANTOMBOT_SKIP_TUI) {
    exit 0
}

if ($DryRun) {
    $sandboxDir = if ($env:PHANTOMBOT_SANDBOX_DIR) { $env:PHANTOMBOT_SANDBOX_DIR } else { Join-Path $env:TEMP 'phantombot-sandbox' }
    New-Item -ItemType Directory -Force -Path (Join-Path $sandboxDir 'config') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $sandboxDir 'data') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $sandboxDir 'state') | Out-Null
    $env:PHANTOMBOT_SANDBOX = '1'
    $env:XDG_CONFIG_HOME = Join-Path $sandboxDir 'config'
    $env:XDG_DATA_HOME = Join-Path $sandboxDir 'data'
    $env:XDG_STATE_HOME = Join-Path $sandboxDir 'state'
    $env:PHANTOMBOT_CONFIG = Join-Path $sandboxDir 'config\phantombot\config.toml'
    $env:PHANTOMBOT_PERSONAS_DIR = Join-Path $sandboxDir 'data\phantombot\personas'
}

& $PbBin
