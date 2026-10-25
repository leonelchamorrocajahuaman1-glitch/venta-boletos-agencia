@echo off
rem ============================================================
rem  Las Cobras Viajes - inicio con doble clic (Windows)
rem  Esta laptop = SERVIDOR + ADMINISTRADOR
rem  El celular  = CLIENTE (mismo Wi-Fi)
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
title Las Cobras Viajes - Servidor

where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instala la version 22 o superior desde https://nodejs.org y vuelve a abrir este archivo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias por primera vez...
  call npm install
)

rem Permiso del Firewall para que el celular pueda entrar (se pide una sola vez, como administrador).
netsh advfirewall firewall show rule name=LasCobrasViajes >nul 2>nul
if errorlevel 1 (
  echo.
  echo Se pedira permiso de administrador para abrir el puerto 3000 en el Firewall de Windows.
  echo Pulsa SI en la ventana que aparece.
  powershell -NoProfile -Command "Start-Process -Verb RunAs -Wait -FilePath netsh -ArgumentList 'advfirewall','firewall','add','rule','name=LasCobrasViajes','dir=in','action=allow','protocol=TCP','localport=3000','profile=any'"
)

set ABRIR_NAVEGADOR=1
call npm start
pause
