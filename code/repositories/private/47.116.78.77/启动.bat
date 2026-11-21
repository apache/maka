@echo off
rem 本地预览 47.116.78.77 镜像站（home=课程，harness=幻灯片），Ctrl+C 停止
cd /d %~dp0
start "" http://127.0.0.1:8777/home/
python -m http.server 8777
