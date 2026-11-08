$env:Path="C:\dev\tools\bun;"+$env:Path
Set-Location C:\dev\work\t-luckydraw78
git fetch -f C:\dev\work\ld2.bundle release/luckydraw-2026-11-02:rel-head 2>&1 | Out-File C:\dev\work\l2-git.log
git checkout -q -f rel-head
git rev-parse --short HEAD | Out-File -Append C:\dev\work\l2-git.log
& C:\dev\tools\bun\bun.exe test --isolate --timeout 120000 apps/edge/test/ai-signin.test.ts apps/edge/test/game-id-payment.test.ts apps/edge/test/google-signin.test.ts apps/edge/test/migrations.test.ts apps/edge/test/no-participant-payment.test.ts apps/edge/test/pay.test.ts apps/edge/test/paylink.test.ts apps/edge/test/price-adjust-secret.test.ts apps/edge/test/price-adjust.test.ts apps/web/test/brand-site.test.ts apps/web/test/cache-versioning.test.ts apps/web/test/consent-pages.test.ts apps/web/test/guide.test.ts apps/web/test/owner-desk.test.ts apps/web/test/phone-guest.test.ts apps/web/test/pwa.test.ts apps/web/test/seo.test.ts apps/web/test/signin-one-page.test.ts apps/web/test/wording-guard.test.ts  *> C:\dev\work\l2-tgt.log
"exit=$LASTEXITCODE" | Out-File -Append C:\dev\work\l2-tgt.log
$t=Get-Date
& C:\dev\tools\bun\bun.exe test --isolate --timeout 120000 packages apps tools/control-worker *> C:\dev\work\l2-full.log
"exit=$LASTEXITCODE secs=$([int]((Get-Date)-$t).TotalSeconds)" | Out-File -Append C:\dev\work\l2-full.log
"DONE" | Out-File C:\dev\work\l2-done.txt
