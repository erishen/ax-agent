# Release — AX Agent

发布前请先跑全量验证，并按下方步骤走完签名 / 公证闭环。

## 0. 前置条件（发布签名所需，本地开发可跳过）

- Apple Developer ID **Application** 证书（`security find-identity -p codesigning -v` 可见）
- 公证用 App Store Connect API key 或 `AC_PASSWORD`（`xcrun notarytool` 需要）
- 项目已配置好 entitlements（`src-tauri/entitlements.plist`）与
  `NSScreenCaptureUsageDescription`（`src-tauri/Info.plist`），构建时自动合并

本地没有证书时：`make build` / `make install` 仍可用（ad-hoc 签名），
但**不嵌入 entitlements、不可公证、分发给别人会被 Gatekeeper 拦截**。

## 1. 全量验证

```bash
make verify   # npm test → tsc → clippy(-D warnings) → cargo test，失败即停
make audit    # 前端依赖漏洞审计（走官方 registry）
```

## 2. 版本号

同步三处（当前 0.1.0）：

| 文件 | 字段 |
|---|---|
| `src-tauri/tauri.conf.json` | `version` |
| `package.json` | `version` |
| `src-tauri/Cargo.toml` | `version` |

建议同时更新 README（如有版本描述）。

## 3. 构建

```bash
make build        # tauri build → .app + .dmg
```

产物：

- `.app`:  `../target/release/bundle/macos/AX Agent.app`
- `.dmg`:  `../target/release/bundle/dmg/AX Agent_<version>_<arch>.dmg`

## 4. 产物自检（构建后必查）

```bash
APP="../target/release/bundle/macos/AX Agent.app"

# 签名存在（发布签名应显示 Developer ID，而非 adhoc）
codesign -dv "$APP" 2>&1 | grep -E "Signature|Identifier"

# entitlements 已嵌入（allow-jit / screen-capture 等 4 项）
codesign -d --entitlements - "$APP" 2>&1 | grep -E "cs\.|device\."

# 屏幕录制用途说明已合并进 Info.plist
plutil -p "$APP/Contents/Info.plist" | grep NSScreenCaptureUsageDescription

# Gatekeeper 隔离属性应被移除（本机构建无隔离，分发的需在目标机验证）
xattr -l "$APP" 2>/dev/null | grep -c quarantine || echo "no quarantine"
```

本地 ad-hoc 时第 1、2 项会显示 `adhoc` / 无 entitlements——属预期，见第 0 节。

## 5. 签名 + 公证（有证书时）

Tauri 构建若检测到证书会自动签名；也可手工补签（注意覆盖 Tauri 产物）：

```bash
codesign --force --deep --sign "Developer ID Application: <你的名字>" \
  --entitlements src-tauri/entitlements.plist --options runtime "$APP"

# 公证（产物用 zip 或 dmg 提交）
ditto -c -k --keepParent "$APP" /tmp/AX\ Agent.zip
xcrun notarytool submit /tmp/AX\ Agent.zip \
  --keychain-profile "AX-Notary" --wait
# 成功后盖章
xcrun stapler staple "$APP"
spctl --assess --type execute --verbose=4 "$APP"   # 应显示 accepted
```

## 6. 安装验证

```bash
make install        # 装到 /Applications（会先停运行中的实例）
open "/Applications/AX Agent.app"
```

首次启动按提示授权：辅助功能 / 屏幕录制 / 输入监控（系统设置 → 隐私与安全性）。

## 7. 打标签（有 remote 时）

```bash
git add -A && git commit -m "chore(release): v0.1.0"
git tag -a v0.1.0 -m "AX Agent v0.1.0"
git push origin main --tags
```

## 常见问题

- **构建报 codesign 失败**：检查 `src-tauri/tauri.conf.json` 的 `bundle.macOS`
  `entitlements` 路径是否指向 `entitlements.plist`，证书是否在钥匙串可用。
- **公证被拒**：`xcrun notarytool log <submission-id>` 看日志；常见原因——
  hardened runtime 未开、未嵌入 entitlements、含未签名 dylib（检查
  `codesign -dv --verbose=4` 的 `TeamIdentifier`）。
- **分发给别人打不开**：确认已 `stapler staple`（Gatekeeper 查询公证）且
  spctl 评估为 accepted；离线签名（ad-hoc）无法分发。
