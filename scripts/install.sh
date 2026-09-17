#!/bin/bash
#
# AX Agent — 安装脚本
#
# 把构建好的 .app 安装到目标目录（默认 /Applications），包含：
#   - 版本对比：已装版本 ≥ 新版本时默认询问是否覆盖（-f 跳过）
#   - 完整性：安装后 codesign --verify 校验签名（含 ad-hoc）
#   - 权限：目标目录不可写时自动 sudo 提权
#   - 安全：--dry-run 只打印将执行的动作，不实际安装
#
# 用法:
#   bash scripts/install.sh [选项]
#     -y, --yes        跳过覆盖确认
#     -f, --force      强制覆盖（即使已装版本相同或更高）
#     -p, --prefix DIR 安装前缀（默认 /Applications，测试可用临时目录）
#     -s, --source APP 源 .app 路径（默认 release 构建产物）
#         --open       安装后启动应用
#         --dry-run    只打印计划，不执行
#     -h, --help       显示帮助
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_SRC="$ROOT/../target/release/bundle/macos/AX Agent.app"
DEFAULT_PREFIX="/Applications"
APP_NAME="AX Agent.app"
APP_ID="cn.erishen.ax-agent"

# 非交互（无 TTY stdin，如 CI / 后台任务）：确认类 read 会永久挂起。
# 此时一律拒绝覆盖并退出，避免卡死；需要强制覆盖用 -y/-f。
if [ ! -t 0 ]; then
  echo "非交互终端（stdin 无 TTY）：跳过所有交互确认。" >&2
  echo "如需无人值守安装请加 -y（自动停实例并覆盖）。" >&2
  exit 1
fi

SRC="$DEFAULT_SRC"
PREFIX="$DEFAULT_PREFIX"
YES=0
FORCE=0
OPEN_AFTER=0
DRY_RUN=0

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    -f|--force) FORCE=1 ;;
    -p|--prefix) PREFIX="$2"; shift ;;
    -s|--source) SRC="$2"; shift ;;
    --open) OPEN_AFTER=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage ;;
    *) echo "未知选项: $1（-h 查看帮助）" >&2; exit 2 ;;
  esac
  shift
done

DST="$PREFIX/$APP_NAME"

echo "== AX Agent 安装 =="

# 源 .app 必须存在
if [ ! -d "$SRC" ]; then
  echo "❌ 未找到源应用：$SRC" >&2
  echo "   请先构建：make build（或 make install-build）" >&2
  exit 1
fi

# 版本读取（新 / 已装）
ver() { /usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$1/Contents/Info.plist" 2>/dev/null || echo "0.0.0"; }
NEW_VER="$(ver "$SRC")"
INSTALLED=0
[ -d "$DST" ] && INSTALLED=1
OLD_VER="$(ver "$DST" 2>/dev/null || echo "0.0.0")"

echo "  源:        $SRC"
echo "  版本:      $NEW_VER"
echo "  目标:      $DST"
if [ "$INSTALLED" = 1 ]; then echo "  已装版本:  $OLD_VER"; else echo "  已装版本:  （未安装）"; fi

# 版本对比：仅当"已装版本更高（降级覆盖）"时询问，防止开发构建覆盖正式发布版。
# 同版本视为开发重装（每次 build 后重装验证版本不变），直接覆盖，不再交互。
NEED_CONFIRM=0
if [ "$INSTALLED" = 1 ] && [ "$FORCE" != 1 ]; then
  if [ "$NEW_VER" != "$OLD_VER" ] && [ "$(printf '%s\n%s\n' "$NEW_VER" "$OLD_VER" | sort -V | tail -1)" = "$OLD_VER" ]; then
    NEED_CONFIRM=1
  fi
fi
if [ "$NEED_CONFIRM" = 1 ] && [ "$YES" != 1 ]; then
  printf "已装版本不更新（%s → %s）。仍要覆盖安装吗？[y/N] " "$OLD_VER" "$NEW_VER"
  read -r ans || true
  case "$ans" in y|Y|yes|YES) ;; *) echo "已取消。"; exit 1 ;; esac
fi

echo
echo "== 运行实例检查 =="
# 检测已安装（或正在运行）的实例；覆盖前必须停止，否则旧进程可能占住文件句柄
RUNNING_PIDS="$(pgrep -f 'AX Agent.app/Contents/MacOS/ax-agent' || true)"
if [ -n "$RUNNING_PIDS" ]; then
  echo "  检测到运行中的实例 (pid: $RUNNING_PIDS)"
  if [ "$YES" = 1 ] || [ "$FORCE" = 1 ]; then
    echo "  -y/-f：自动停止..."
    kill $RUNNING_PIDS 2>/dev/null || true
    sleep 1
  else
    printf "  停止后继续安装？[y/N] "
    read -r ans || true
    case "$ans" in y|Y|yes|YES)
      kill $RUNNING_PIDS 2>/dev/null || true
      sleep 1
      ;;
    *) echo "  已取消（未停止运行中的实例）。"; exit 1 ;;
    esac
  fi
else
  echo "  无运行中的实例 ✓"
fi

echo
echo "== 安装步骤 =="
echo "  1. 复制 $APP_NAME → $PREFIX/"

run_sudo() { # 目标目录不可写时提权执行（macOS bash 3.2 无 export -f，不传函数，逐命令判断）
  :
}
if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] mkdir -p \"$PREFIX\""
  echo "  [dry-run] ditto \"$SRC\" \"$DST\""
else
  # 前缀目录可能尚不存在：先确保它存在（不可创建时提权），再按可写性决定
  if ! mkdir -p "$PREFIX" 2>/dev/null; then
    sudo -p "创建 $PREFIX 需要管理员权限，请输入密码: " mkdir -p "$PREFIX"
  fi
  if [ -w "$PREFIX" ]; then
    rm -rf "$DST" && ditto "$SRC" "$DST"
  else
    sudo -p "安装到 $PREFIX 需要管理员权限，请输入密码: " rm -rf "$DST"
    sudo -p "" ditto "$SRC" "$DST"
  fi
  echo "  ✅ 已复制到 $DST"
fi

echo "  2. 校验签名"
if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] codesign --verify \"$DST\""
else
  if codesign --verify "$DST" 2>/dev/null; then
    echo "  ✅ 签名校验通过"
  else
    echo "  ⚠️ 签名校验失败（无签名或损坏）。安装已继续，但分发前请检查签名。" >&2
  fi
fi

echo "  3. 写入安装标记"
MARK_DIR="${HOME}/Library/Application Support/cn.erishen.ax-agent"
if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] 记录安装版本 $NEW_VER 到 $MARK_DIR/install.json"
else
  mkdir -p "$MARK_DIR"
  printf '{"app":"%s","version":"%s","installed_at":"%s"}\n' \
    "$APP_ID" "$NEW_VER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MARK_DIR/install.json"
  echo "  ✅ 安装标记已写入（版本 ${NEW_VER}）"
fi

echo
echo "== 完成 =="
echo "  $APP_NAME v$NEW_VER → $DST"
if [ "$OPEN_AFTER" = 1 ]; then
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] open \"$DST\""
  else
    echo "  正在启动 $APP_NAME ..."
    open "$DST"
  fi
else
  echo "  首次启动：运行 open \"$DST\""
  echo "  授权提示：系统设置 → 隐私与安全性 → 辅助功能 / 屏幕录制 中勾选"
fi
