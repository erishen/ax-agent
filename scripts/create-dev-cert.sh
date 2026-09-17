#!/bin/bash
# AX Agent — 创建本地代码签名证书（"AX Agent Local Dev"）
#
# 为什么需要：ad-hoc 签名每次构建 cdhash 都变，macOS 辅助功能授权
# （TCC）绑定旧签名，导致每次 make install 后都要重新授权。改用
# 稳定自签证书签名后，授权一次长期有效，且 entitlements 能正常嵌入。
#
# 用法: bash scripts/create-dev-cert.sh
# 幂等：证书已存在时直接跳过。

set -euo pipefail

CERT_CN="AX Agent Local Dev"

# 已存在则跳过（含已信任状态）
if security find-identity -v -p codesigning 2>/dev/null | grep -q "${CERT_CN}"; then
  echo "✅ 证书已存在（${CERT_CN}），无需创建。"
  exit 0
fi

TMPDIR_X="$(mktemp -d)"
KEY="$TMPDIR_X/key.pem"
CERT="$TMPDIR_X/cert.pem"
P12="$TMPDIR_X/dev.p12"
cleanup() { rm -rf "$TMPDIR_X"; }
trap cleanup EXIT

echo "== 生成自签代码签名证书: ${CERT_CN} =="
openssl req -x509 -newkey rsa:2048 -keyout "$KEY" -out "$CERT" -days 3650 -nodes \
  -subj "/CN=${CERT_CN}" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" 2>/dev/null

# openssl 3 默认算法与 macOS 钥匙串不兼容，必须 -legacy（RC2/3DES）
openssl pkcs12 -export -legacy -out "$P12" -inkey "$KEY" -in "$CERT" -passout pass:axdev 2>/dev/null
security import "$P12" -k ~/Library/Keychains/login.keychain-db -P axdev -T /usr/bin/codesign >/dev/null

# 设为代码签名信任，使 find-identity 返回有效身份（tauri 依赖它匹配）
security add-trusted-cert -d -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db "$CERT" >/dev/null

echo "✅ 证书已创建并导入登录钥匙串。"
echo "   build-app 将自动使用 APPLE_SIGNING_IDENTITY=\"${CERT_CN}\" 签名。"
echo "   注意：首次用新签名安装后，若系统弹出辅助功能授权，勾选一次即可长期生效。"
