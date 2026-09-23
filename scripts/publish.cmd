@echo off
REM Public kopyayi (yerel "public" dali -> github "public" remote'unun main'i) calisma daliyla esitler.
REM Gecmis tasinmaz: public dalina tek bir "sync" commit'i eklenir. Gitignore'daki kisisel dosyalar dokunulmaz.
REM Yerel "public" dali her seferinde uzaktakinden yeniden kurulur; baska yerden push edilmisse de ayrismaz.
setlocal
set WORK=claude/new-session-vm4l3e
for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD') do set CUR=%%b
git fetch public main || exit /b 1
git checkout -B public refs/remotes/public/main || exit /b 1
git read-tree -u --reset %WORK% || exit /b 1
git add -A
git commit -m "sync from %WORK% (%date% %time%)" || echo (degisiklik yok)
git push public public:main || exit /b 1
git checkout %CUR%
endlocal
