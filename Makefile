SHELL := /bin/bash

.PHONY: help dev build install install-build uninstall verify check clean clean-macros fe-install fe-build audit typecheck lint fmt clippy release rpc rpc-ping rpc-health

help: ## 显示可用命令
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

dev: ## 启动桌面应用（只清理本项目的残留进程与 1520 端口，再 vite 热更新 + Rust 编译）
	@echo "[kill-dev] 清理残留 ax-agent 进程..."
	@pkill -f 'target/debug/ax-agent' 2>/dev/null || true
	@pkill -f 'target/release/ax-agent' 2>/dev/null || true
	@# 只清理本项目的 vite（匹配本项目路径，绝不能误杀 sprite 的 vite）
	@pkill -f 'ax-agent/node_modules/.bin/vite' 2>/dev/null || true
	@# 清理占用 1520 端口的进程（本项目 vite dev server；1420 属于 sprite，永不触碰）
	@if lsof -ti:1520 > /dev/null 2>&1; then \
		echo "[kill-dev] 清理占用 1520 端口的进程..."; \
		lsof -ti:1520 | xargs kill -9 2>/dev/null || true; \
	fi
	@sleep 1
	@echo "[kill-dev] 清理完成，启动开发服务器..."
	@# 首次运行需在 系统设置 → 隐私与安全性 → 辅助功能 中勾选本终端
	pnpm run tauri dev

build: ## 构建 release 安装包（.app / .dmg）
	pnpm run tauri build

build-app: ## 构建 release 的 .app（不生成 DMG，本地安装用，避免污染发布包）
	pnpm run tauri build --bundles app

install: build-app ## 构建（仅 .app）并安装到 /Applications（先停止运行中的实例；选项: make install INSTALL_FLAGS="-y"）
	@echo "[install] 停止运行中的 ax-agent 实例..."
	@pkill -f '/Applications/AX Agent.app/Contents/MacOS/ax-agent' 2>/dev/null || true
	@pkill -f 'target/release/ax-agent' 2>/dev/null || true
	@pkill -f 'target/debug/ax-agent' 2>/dev/null || true
	@# 等进程完全退出，避免覆盖时文件句柄占用
	@sleep 1
	bash scripts/install.sh $(INSTALL_FLAGS)

install-build: install ## 同 install：构建（仅 .app）并安装

uninstall: ## 从 /Applications 卸载（默认保留数据；--purge 连数据一起删）
	bash scripts/uninstall.sh $(INSTALL_FLAGS)

fe-install: ## 安装前端依赖
	pnpm install

audit: ## 前端依赖漏洞审计（npmmirror 无 audit endpoint，改用官方 registry 查询）
	pnpm audit --registry=https://registry.npmjs.org --prod

fe-build: ## 仅构建前端产物（tsc + vite → dist/）
	pnpm run build

typecheck: ## TypeScript 类型检查
	pnpm exec tsc --noEmit

check: ## Rust 编译检查（仅 ax-agent，避免整 workspace 触发无关大数据依赖重建；需先 fe-build 嵌入资源）
	cd src-tauri && cargo check -p ax-agent

fmt: ## 格式化 Rust 代码
	cd src-tauri && cargo fmt

clippy: ## Rust clippy 静态检查（仅 ax-agent，避免整 workspace；RUSTC_WRAPPER= 绕过 sccache）
	cd src-tauri && RUSTC_WRAPPER= cargo clippy -p ax-agent --all-targets -- -D warnings

lint: ## 代码检查（TypeScript 类型 + Rust clippy）
	@echo "=== TypeScript 类型检查 ==="
	pnpm exec tsc --noEmit
	@echo "=== Rust clippy ==="
	cd src-tauri && RUSTC_WRAPPER= cargo clippy -p ax-agent --all-targets -- -D warnings

verify: ## 全量验证（前端测试 → 类型检查 → clippy → Rust 测试，任一步失败即停）
	@echo "=== [1/4] 前端单元测试 ==="
	npm test
	@echo "=== [2/4] TypeScript 类型检查 ==="
	pnpm exec tsc --noEmit
	@echo "=== [3/4] Rust clippy（-D warnings）==="
	cd src-tauri && RUSTC_WRAPPER= cargo clippy -p ax-agent --all-targets -- -D warnings
	@echo "=== [4/4] Rust 单元测试 ==="
	cd src-tauri && RUSTC_WRAPPER= cargo test -p ax-agent --lib
	@echo "✅ 全量验证通过"

clean-macros: ## 删除共享 target 中宏库 .dylib（解决 mismatched ABI，cargo 会自动重编）
	@echo "删除共享 target 中所有宏库 .dylib 文件..."
	rm -f ../target/debug/deps/*.dylib
	@echo "完成。下次 make dev 时 cargo 会自动重新编译宏库。"

clean: ## 清理前端产物与依赖
	rm -rf node_modules dist src-tauri/target src-tauri/gen

rpc: ## 调用 JSON-RPC 客户端（需先 app 正在运行）。例: make rpc ARGS="tree 123"（也可 list-apps / shot 123 out.png）
	python3 scripts/ax-rpc.py $(ARGS)

rpc-ping: ## 探测 JSON-RPC 服务是否在线
	python3 scripts/ax-rpc.py ping

rpc-health: ## curl /health 探测服务
	curl -s http://127.0.0.1:8931/health && echo
