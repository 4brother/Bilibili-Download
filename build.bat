@echo off
chcp 65001 >nul
title Bilibili Downloader - Build
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
echo.
pause
