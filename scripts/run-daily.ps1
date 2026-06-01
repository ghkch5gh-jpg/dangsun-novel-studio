# 현상설계 오피스 드라마 웹소설 매일 생성 — Windows 작업 스케줄러가 08:45 KST 에 호출.
$ErrorActionPreference = 'Continue'
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;C:\Users\myh43\AppData\Roaming\npm;$env:Path"
# repo 루트 = 이 스크립트(repo\scripts\run-daily.ps1)의 부모의 부모.
# 한글 경로 리터럴을 두면 BOM 없는 .ps1을 PS5.1이 CP949로 오독해 경로가 깨짐 → $PSScriptRoot로 회피.
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$log = Join-Path $repo 'daily.log'
function Log($m) { "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m | Out-File -FilePath $log -Append -Encoding utf8 }

Log "==== start ===="
git pull --quiet origin main *>> $log
node scripts/build-local.mjs *>> $log
if ($LASTEXITCODE -ne 0) { Log "generator failed (exit $LASTEXITCODE)"; exit 1 }
node scripts/review.mjs *>> $log
if ($LASTEXITCODE -ne 0) { Log "review failed (exit $LASTEXITCODE) — skip" }
git add -A *>> $log
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m ("daily: " + (Get-Date -Format 'yyyy-MM-dd') + " episode") *>> $log
  git push origin main *>> $log
  Log "pushed"
} else { Log "no changes (today's episode already exists)" }
