@echo off
cd /d "%~dp0"
title Publicar Telao na Cloudflare

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale em https://nodejs.org e rode de novo.
  pause
  exit /b 1
)

echo Instalando dependencias...
call npm install --no-audit --no-fund
echo.

call npx wrangler whoami 2>nul | findstr /I /C:"logged in" >nul
if errorlevel 1 (
  echo Vai abrir o navegador para voce entrar na sua conta Cloudflare e autorizar.
  call npx wrangler login
)

echo.
echo Publicando...
call npx wrangler deploy
echo.
echo Pronto! O endereco do Telao aparece acima (termina em .workers.dev).
echo Mande esse endereco para os amigos. Ele fica no ar mesmo com seu PC desligado.
pause
