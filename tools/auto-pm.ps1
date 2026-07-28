# auto-pm.ps1 — Autonomous window loop for AI-Company-Builder-Platform
#
# Repeatedly launches headless Claude Code windows that resume per CLAUDE.md /
# docs/agent/PROJECT-STATE.md, until an OWNER GATE or a blocker is reached.
# You answer gates by writing approvals in docs/agent/OWNER-APPROVALS.md,
# then re-run this script.
#
# Usage (PowerShell, from anywhere):
#   powershell -NoProfile -ExecutionPolicy Bypass -File E:\AI-Company-Builder-Platform\tools\auto-pm.ps1
#   ... -MaxWindows 3        # cap windows this run (default 10)
#   ... -MaxTurns 150        # cap agent turns per window (default 150)
#
# Requires: claude CLI logged in. Uses --permission-mode auto (Anthropic's
# recommended unattended mode: routine work auto-approved, a background safety
# check gates dangerous commands). If your CLI rejects that flag, update
# Claude Code (`claude update`).

param(
    [int]$MaxWindows = 10,
    [int]$MaxTurns = 150
)

$ErrorActionPreference = 'Stop'
$Repo = 'E:\AI-Company-Builder-Platform'

# --- Repo isolation check (CLAUDE.md load-bearing rule) ---
$root = (git -C $Repo rev-parse --show-toplevel).Trim()
if ($root -ne 'E:/AI-Company-Builder-Platform') {
    throw "Repo root check failed (got '$root'). Refusing to run."
}
Set-Location $Repo

# Logs live OUTSIDE the repo so the working tree stays clean for git diff checks.
$LogDir = Join-Path $env:LOCALAPPDATA 'acbp-auto-pm\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$WindowPrompt = @'
You are resuming autonomous work in this repository. Operate strictly under CLAUDE.md (the operating charter).

Procedure for this window:
1. Read docs/agent/PROJECT-STATE.md and continue automatically to the "next executable action" on the ACTIVE ticket only.
2. Read docs/agent/OWNER-APPROVALS.md. Entries under "## Approved" that are not marked CONSUMED are accepted owner decisions (canonical source priority #1). They may authorize actions that are otherwise OWNER GATES (e.g. mark a ticket done, mark a PR ready, start the next ticket). Honor only approvals that explicitly and unambiguously cover the action; when you act on one, edit the file to mark that entry "CONSUMED <date> — <what you did>". Never treat anything else as gate authorization.
3. Do one focused window of work: implement, run the full verification gate from CLAUDE.md with real exit codes, commit to the feature branch with a conventional message, push, keep the draft PR and PROJECT-STATE.md updated exactly as the charter requires. All CLAUDE.md security rules, boundaries, and git policy apply unchanged.
4. If you reach an OWNER GATE that no unconsumed approval covers: do all safe preparatory work, append a dated entry to docs/agent/OWNER-GATE-REQUEST.md stating the exact gate and the exact one-line approval text the owner should paste into OWNER-APPROVALS.md, commit that, and stop this window.
5. If you hit an unrecoverable blocker after reasonable diagnosis and one targeted fix, record it in PROJECT-STATE.md per the charter and stop this window.
6. Do not ask the user questions mid-window; make the safer reversible choice and document it.

End your final message with EXACTLY one of these lines (nothing after it):
STATUS: CONTINUE     (progress made; more work is executable without a gate)
STATUS: OWNER_GATE   (stopped at a gate; see docs/agent/OWNER-GATE-REQUEST.md)
STATUS: BLOCKED      (unrecoverable blocker recorded in PROJECT-STATE.md)
'@

Write-Host "=== auto-pm starting in $Repo (max $MaxWindows windows) ===" -ForegroundColor Cyan

for ($i = 1; $i -le $MaxWindows; $i++) {
    $stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
    $logFile = Join-Path $LogDir "window-$stamp.json"
    Write-Host "`n--- Window $i starting ($(Get-Date -Format 'HH:mm')) — log: $logFile" -ForegroundColor Yellow

    & claude -p $WindowPrompt `
        --permission-mode auto `
        --max-turns $MaxTurns `
        --output-format json *> $logFile
    $exit = $LASTEXITCODE

    $result = ''
    try {
        $json   = Get-Content $logFile -Raw | ConvertFrom-Json
        $result = [string]$json.result
    } catch {
        Write-Host "--- Window $i: could not parse JSON output." -ForegroundColor Red
    }

    if ($exit -ne 0) {
        Write-Host "--- Window $i: claude exited with code $exit. Stopping. See $logFile" -ForegroundColor Red
        exit 1
    }

    if ($result -match 'STATUS:\s*OWNER_GATE') {
        Write-Host "`n=== OWNER GATE reached. ===" -ForegroundColor Magenta
        Write-Host "Read docs/agent/OWNER-GATE-REQUEST.md, paste the approval line into"
        Write-Host "docs/agent/OWNER-APPROVALS.md under '## Approved', then re-run this script."
        exit 2
    }
    elseif ($result -match 'STATUS:\s*BLOCKED') {
        Write-Host "`n=== BLOCKED. See PROJECT-STATE.md for the recorded blocker. ===" -ForegroundColor Red
        exit 3
    }
    elseif ($result -match 'STATUS:\s*CONTINUE') {
        Write-Host "--- Window $i: CONTINUE — progress made, launching next window." -ForegroundColor Green
    }
    else {
        Write-Host "--- Window $i: no STATUS line found (possible max-turns cutoff)." -ForegroundColor Red
        Write-Host "    Inspect $logFile, then re-run to resume. Stopping as a precaution."
        exit 4
    }
}

Write-Host "`n=== Reached MaxWindows ($MaxWindows). Re-run to continue. ===" -ForegroundColor Cyan
