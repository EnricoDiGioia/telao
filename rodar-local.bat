@echo off
cd /d "%~dp0"
title Telao

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale em https://nodejs.org e rode de novo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias...
  call npm install
)

REM --- Opcional: servidor TURN (veja o README) ---
REM set TURN_URL=turn:seu-servidor:3478,turns:seu-servidor:443
REM set TURN_USER=usuario
REM set TURN_PASS=senha

REM --- Opcional: porta e limite de pessoas por sala ---
REM set PORT=3000
REM set MAX_PER_ROOM=8

node server.js
pause
