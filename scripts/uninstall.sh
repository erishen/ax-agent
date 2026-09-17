#!/bin/bash
#
# AX Agent — 卸载脚本
#
# 默认只移除应用本体（/Applications/AX Agent.app），保留你的数据
# （LLM 配置、会话日志、使用习惯）。--purge 会连同数据一起删除。
#
# 用法:
#   bash scripts/uninstall.sh [选项]
#     -p, --prefix DIR 应用所在前缀（默认 /Applications）
#         --purge      同时删除应用数据（llm.json / sessions.md / memory.json 等）
#         --dry-run    只打印计划，不执行
#     -h, --help       显示帮助
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="/Applications"
APP_NAME="AX Agent.app"
PURGE=0
DRY_RUN=0

usage() { sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--prefix) PREFIX="$2"; shift ;;
    --purge) PURGE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage ;;
    *) echo "未知选项: $1（-h 查看帮助）" >&2; exit 2 ;;
  esac
  shift
done

DST="$PREFIX/$APP_NAME"
DATA_DIR="$HOME/Library/Application Support/cn.erishen.ax-agent"
RPC_DIR="$HOME/.ax-agent"

if [ ! -d "$DST" ]; then
  echo "未找到 ${DST}，可能已卸载。" >&2
  exit 1
fi

echo "== 卸载 AX Agent =="
echo "  应用:   $DST"
if [ "$PURGE" = 1 ]; then
  echo "  数据:   $DATA_DIR"
  echo "          ${RPC_DIR}（RPC 令牌）"
  echo "  ⚠️  将连同数据一起删除，此操作不可恢复。"
fi

printf "确认卸载？[y/N] "
if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] 跳过确认，仅展示计划"
else
  read -r ans || true
  case "$ans" in y|Y|yes|YES) ;; *) echo "已取消。"; exit 1 ;; esac
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] rm -rf \"$DST\""
  [ "$PURGE" = 1 ] && echo "  [dry-run] rm -rf \"$DATA_DIR\" \"$RPC_DIR\""
else
  if [ -w "$PREFIX" ]; then
    rm -rf "$DST"
  else
    sudo -p "删除 $DST 需要管理员权限，请输入密码: " rm -rf "$DST"
  fi
  echo "  ✅ 应用已卸载"
  if [ "$PURGE" = 1 ]; then
    rm -rf "$DATA_DIR" "$RPC_DIR"
    echo "  ✅ 数据已删除"
  else
    echo "  ℹ️  数据已保留（llm.json / sessions.md 等）；如需删除请加 --purge"
  fi
fi
echo "== 完成 =="
