<#
.SYNOPSIS
  phantombot installer for Windows.

.DESCRIPTION
  PowerShell parallel to install.sh. Usage:

    iwr -useb https://raw.githubusercontent.com/phantomyard/phantombot/main/install.ps1 | iex
    .\install.ps1 [-DryRun]

  What it does:
    1. Clears screen, displays animated phantom intro banner, and prompts to install.
    2. Inspects system and arch.
    3. Downloads and installs phantombot.exe to %LOCALAPPDATA%\Programs\phantombot and checks PATH.
    4. Prompts for background service / autostart at boot (asks for Windows password).
    5. Launches the Phantombot TUI (in sandbox mode if -DryRun).

  Override the install dir with $env:PHANTOMBOT_INSTALL_DIR.
  Skip the TUI launch with $env:PHANTOMBOT_SKIP_TUI=1 (e.g. CI smoke tests).
  Run without making changes with -DryRun (or $env:PHANTOMBOT_DRY_RUN=1).
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$InstallDir = $env:PHANTOMBOT_INSTALL_DIR
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:PHANTOMBOT_DRY_RUN -or $env:PHANTOMBOT_DRYRUN) { $DryRun = $true }

$Repo = 'phantomyard/phantombot'

function Fail([string]$msg) {
    Write-Host " failed"
    [Console]::Error.WriteLine("phantombot: $msg")
    exit 1
}

# --- Console encoding -----------------------------------------------------
# Windows PowerShell 5.1 renders host output in the console's OEM codepage, so
# the banner's box-drawing glyphs arrive as '?' unless we ask for UTF-8 first.
try {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
} catch {
}

# --- TLS ------------------------------------------------------------------
try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
}

# --- 1. Clear Screen & Presentation Animation -----------------------------
$isInteractive = [Environment]::UserInteractive -and -not [Console]::IsOutputRedirected

if ($isInteractive) {
    try {
        [Console]::Clear()
    } catch {
        Write-Host "`e[2J`e[3J`e[H" -NoNewline
    }
}

$esc = [char]27
$c24  = "$esc[38;5;24m"
$c26  = "$esc[38;5;26m"
$c33  = "$esc[38;5;33m"
$c39  = "$esc[38;5;39m"
$c45  = "$esc[38;5;45m"
$c51  = "$esc[38;5;51m"
$c87  = "$esc[38;5;87m"
$c123 = "$esc[38;5;123m"
$c159 = "$esc[38;5;159m"
$c231 = "$esc[38;5;231m"
$c21  = "$esc[38;5;21m"
$c27  = "$esc[38;5;27m"

$d236 = "$esc[38;5;236m"
$d240 = "$esc[38;5;240m"
$d245 = "$esc[38;5;245m"

$w0   = "$esc[38;5;231m"
$reset= "$esc[0m"
$bold = "$esc[1m"

$phantomLines = @(
    "                     $c24▄▄▄▄████████▄▄▄▄$reset",
    "                 $c26▄▄███▀▀▀        ▀▀▀███▄▄$reset",
    "              $c33▄███▀     $c39▄▄▄██████▄▄▄$reset     $c33▀███▄$reset",
    "            $c39▄██▀     $c45▄███▀▀      ▀▀███▄$reset     $c39▀██▄$reset",
    "           $c45▄██▀     $c51███    $d236▄▄████▄▄$reset    $c51███$reset     $c45▀██▄$reset",
    "          $c51███      $c87███    $d240▄██▀    ▀██▄$reset    $c87███$reset      $c51███$reset",
    "          $c87███      $c123███    $d245██        ██$reset    $c123███$reset      $c87███$reset",
    "          $c123███      $c159███    $d245██ $c33╺$c39━$c45━$c51━$c87╸$w0●$c87╺$c51━$c45━$c39━$c33╸ $d245██$reset    $c159███$reset      $c123███$reset",
    "          $c87███      $c123███    $d245██        ██$reset    $c123███$reset      $c87███$reset",
    "          $c51███      $c87███    $d240▀██▄    ▄██▀$reset    $c87███$reset      $c51███$reset",
    "           $c45▀██▄     $c51███    $d236▀▀████▀▀$reset    $c51███$reset     $c45▄██▀$reset",
    "            $c39▀██▄     $c45▀███▄▄      ▄▄███▀$reset     $c39▄██▀$reset",
    "              $c33▀███▄     $c39▀▀▀██████▀▀▀$reset     $c33▄███▀$reset",
    "                 $c26▀▀███▄▄▄        ▄▄▄███▀▀$reset",
    "                     $c24▀▀▀▀████████▀▀▀▀$reset",
    "",
    "  $c39█████▄ $c45██  ██ $c51▄████▄ $c51███  ██ $c87███████ $c87▄████▄ $c123███▄███  $c123█████▄ $c159▄████▄ $c231███████$reset",
    "  $c33██▄▄██ $c39██  ██ $c45██▄▄██ $c45████ ██ $c51  ██   $c51██  ██ $c87██▀█▀██  $c87██▄▄██ $c123██  ██ $c159  ██   $reset",
    "  $c27██▀▀▀  $c33██████ $c39██▀▀██ $c39██ ████ $c45  ██   $c45██  ██ $c51██ ▀ ██  $c51██▀▀██ $c87██  ██ $c123  ██   $reset",
    "  $c21██     $c27██  ██ $c33██  ██ $c33██  ███ $c39  ██   $c39▀████▀ $c45██   ██  $c45█████▀ $c51▀████▀ $c87  ██   $reset",
    "",
    "    $c33◈$reset  $c123${bold}Learns your world, defends your runtime, never wastes a token.$reset  $c33◈$reset"
)

Write-Host ""
foreach ($l in $phantomLines) {
    Write-Host $l
    if ($isInteractive) {
        Start-Sleep -Milliseconds 15
    }
}
Write-Host ""

# --- 2. Welcome & Confirmation --------------------------------------------
if ($isInteractive) {
    $welcome = Read-Host "Welcome! Do you want to install Phantombot? [Y/n]"
    if ($welcome -and ($welcome.Trim() -match '^(n|no)$')) {
        Write-Host ""
        Write-Host "Installation cancelled."
        exit 0
    }
    Write-Host ""
}

Write-Host "Installing Phantombot..."
Write-Host ""

# --- 3. Inspecting System -------------------------------------------------
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

# --- 4. Downloading Binary ------------------------------------------------
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

# --- 5. Installing Now ----------------------------------------------------
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

# --- 6. Verifying ---------------------------------------------------------
Write-Host -NoNewline "Verifying............."

# A real check, not a decorative one: the installed binary must exist AND run.
# A truncated download or a wrong-arch asset both leave a file that passes
# Test-Path and fails here, so a green tick from a mere existence check is
# worse than no check at all.
if ($DryRun) {
    Write-Host "$([char]0x2713)" -ForegroundColor Green
} elseif (-not $PbBin -or -not (Test-Path $PbBin)) {
    Write-Host "$([char]0x2717)" -ForegroundColor Red
    Write-Error "phantombot: $PbBin is missing"
    exit 1
} else {
    $verifyOut = & $PbBin --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "$([char]0x2717)" -ForegroundColor Red
        Write-Error "phantombot: $PbBin --version failed:`n$verifyOut"
        exit 1
    }
    Write-Host "$([char]0x2713) $verifyOut" -ForegroundColor Green
}

# --- 7. Autostart Service Installation ------------------------------------
$serviceFailed = $false
if (-not $DryRun) {
    Write-Host ""
    Write-Host -NoNewline "Registering service...."
    # `install` registers the \Phantombot\ scheduled tasks AND starts the
    # daemon. Its exit status is the only signal that the agent will come back
    # after a reboot, so a failure is reported rather than discarded.
    try {
        & $PbBin install
        if ($LASTEXITCODE -ne 0) { throw "phantombot install exited $LASTEXITCODE" }
        Write-Host "$([char]0x2713)" -ForegroundColor Green
    } catch {
        Write-Host "$([char]0x2717)" -ForegroundColor Red
        Write-Host "phantombot: service install failed: $($_.Exception.Message)"
        Write-Host "phantombot: the binary is installed and usable; run ``$PbBin install`` to retry the service."
        $serviceFailed = $true
    }
}

Write-Host ""
if ($serviceFailed) {
    Write-Host "Phantombot is installed, but the background service is not - see the error above."
} else {
    Write-Host "Installation completed successfully."
}

# --- 8. Launch TUI --------------------------------------------------------
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
