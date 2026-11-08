$env:Path="C:\dev\tools\bun;"+$env:Path
Set-Location C:\dev\work\t-tambola96
git checkout -q -f 88fa696
git fetch -f C:\dev\work\tr3.bundle release/tambola-2026-11-02 2>&1 | Out-File C:\dev\work\t3-git.log
git checkout -q -f FETCH_HEAD
git rev-parse --short HEAD | Out-File -Append C:\dev\work\t3-git.log
& C:\dev\tools\bun\bun.exe test --isolate --timeout 120000 apps/edge/test/ai-signin.test.ts apps/edge/test/game-id-payment.test.ts apps/edge/test/google-signin.test.ts apps/edge/test/migrations.test.ts apps/edge/test/pay.test.ts apps/edge/test/paylink.test.ts apps/edge/test/price-adjust-secret.test.ts apps/edge/test/price-adjust.test.ts apps/edge/test/wp06-price-footer.test.ts apps/web/test/build-ships-flow.test.ts apps/web/test/cache-versioning.test.ts apps/web/test/guide.test.ts apps/web/test/idlist.test.ts apps/web/test/landing.test.ts apps/web/test/owner-desk.test.ts apps/web/test/phone-guest.test.ts apps/web/test/seo.test.ts apps/web/test/signin-one-page.test.ts apps/web/test/top-menu.test.ts apps/web/test/wording-guard.test.ts apps/web/test/wp01-wording.test.ts  *> C:\dev\work\t3-tgt.log
"exit=$LASTEXITCODE" | Out-File -Append C:\dev\work\t3-tgt.log
$t=Get-Date
& C:\dev\tools\bun\bun.exe test --isolate --timeout 120000 packages apps tools/control-worker *> C:\dev\work\t3-full.log
"exit=$LASTEXITCODE secs=$([int]((Get-Date)-$t).TotalSeconds)" | Out-File -Append C:\dev\work\t3-full.log
"DONE" | Out-File C:\dev\work\t3-done.txt
