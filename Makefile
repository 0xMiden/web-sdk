.DEFAULT_GOAL := help

.PHONY: help
help: ## Show description of all commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

# --- Variables -----------------------------------------------------------------------------------

WEB_CLIENT_DIR=crates/web-client

# --- Linting -------------------------------------------------------------------------------------

.PHONY: clippy-wasm
clippy-wasm: rust-client-ts-build ## Run Clippy for the WASM packages (web client and idxdb store)
	cargo +nightly clippy --package miden-client-web --target wasm32-unknown-unknown --all-targets -- -D warnings
	cargo +nightly clippy --package miden-idxdb-store --target wasm32-unknown-unknown --all-targets -- -D warnings

.PHONY: fix-wasm
fix-wasm: ## Run Fix for the WASM packages (web client and idxdb store)
	cargo +nightly fix --package miden-client-web --target wasm32-unknown-unknown --allow-staged --allow-dirty --all-targets
	cargo +nightly fix --package miden-idxdb-store --target wasm32-unknown-unknown --allow-staged --allow-dirty --all-targets

.PHONY: format
format: ## Run format using nightly toolchain
	cargo +nightly fmt --all
	yarn --silent prettier . --write --log-level silent
	yarn --silent eslint . --fix

.PHONY: format-check
format-check: ## Run format using nightly toolchain but only in check mode
	cargo +nightly fmt --all --check
	yarn --silent prettier . --check
	yarn --silent eslint .

.PHONY: lint
lint: fix-wasm format clippy-wasm typos-check rust-client-ts-lint web-client-check-methods ## Run all linting tasks at once

.PHONY: toml
toml: ## Runs Format for all TOML files
	taplo fmt

.PHONY: toml-check
toml-check: ## Runs Format for all TOML files but only in check mode
	taplo fmt --check --verbose

.PHONY: typos-check
typos-check: ## Run typos to check for spelling mistakes
	@typos --config ./.typos.toml

.PHONY: rust-client-ts-lint
rust-client-ts-lint:
	cd crates/idxdb-store/src && yarn && yarn lint

.PHONY: web-client-check-methods
web-client-check-methods: ## Check that all WASM methods are classified in the web client proxy
	cd $(WEB_CLIENT_DIR) && yarn check:method-classification

.PHONY: react-sdk-lint
react-sdk-lint: ## Run lint for the React SDK
	cd packages/react-sdk && yarn && yarn lint

# --- Documentation -------------------------------------------------------------------------------

.PHONY: typedoc
typedoc: rust-client-ts-build ## Generate web client package documentation.
	@cd crates/web-client && \
	npm run build-dev && \
	yarn typedoc

# --- Testing -------------------------------------------------------------------------------------

.PHONY: test-react-sdk
test-react-sdk: ## Run React SDK unit tests
	cd packages/react-sdk && yarn && yarn test:unit

.PHONY: integration-test-web-client
SHARD_PARAMETER ?= ""
integration-test-web-client: ## Run integration tests for the web client (with a chromium browser)
	cd ./crates/web-client && yarn run test:clean -- --project=chromium $(SHARD_PARAMETER)

.PHONY: integration-test-web-client-webkit
integration-test-web-client-webkit: ## Run web client tests (webkit)
	cd ./crates/web-client && yarn run test -- --project=webkit

.PHONY: integration-test-remote-prover-web-client
integration-test-remote-prover-web-client: ## Run integration tests for the web client with remote prover
	cd ./crates/web-client && yarn run test:remote_prover -- --project=chromium

# --- Building ------------------------------------------------------------------------------------

.PHONY: build-wasm
build-wasm: rust-client-ts-build ## Build the WASM packages (web client and idxdb store)
	cargo build --package miden-client-web --package miden-idxdb-store --target wasm32-unknown-unknown --locked

.PHONY: rust-client-ts-build
rust-client-ts-build:
	cd crates/idxdb-store/src && yarn && yarn build

.PHONY: build-web-client
build-web-client: rust-client-ts-build ## Build web client npm package
	cd $(WEB_CLIENT_DIR) && yarn && yarn build

.PHONY: build-react-sdk
build-react-sdk: ## Build the React SDK package
	cd crates/web-client && yarn && yarn build
	cd packages/react-sdk && yarn && yarn build

# --- Check ---------------------------------------------------------------------------------------

.PHONY: check-wasm
check-wasm: ## Check the WASM packages (web client and idxdb store)
	cargo check --package miden-client-web --target wasm32-unknown-unknown
	cargo check --package miden-idxdb-store --target wasm32-unknown-unknown

## --- Debug --------------------------------------------------------------------------------------

.PHONY: build-web-client-debug
build-web-client-debug: ## Build the web client with debug symbols for the WASM-generated rust code
	cd crates/web-client && yarn build-dev

.PHONY: link-web-client-dep
link-web-client-dep: ## Link the local web-client for debugging JS applications
	cd crates/web-client && yarn link

## --- Setup --------------------------------------------------------------------------------------

.PHONY: install-tools
install-tools: ## Install development tools
	@echo "Installing development tools..."
	@rustup show active-toolchain >/dev/null 2>&1 || (echo "Rust toolchain not detected. Install rustup + toolchain first." && exit 1)
	@echo "Ensuring wasm32-unknown-unknown target is installed..."
	@rustup target add wasm32-unknown-unknown >/dev/null
	@RUST_TC=$$(rustup show active-toolchain | awk '{print $$1}'); \
		echo "Ensuring required Rust components are installed for $$RUST_TC..."; \
		rustup component add --toolchain $$RUST_TC clippy rust-src rustfmt >/dev/null
	cargo install typos-cli@1.42.3 --locked
	cargo install taplo-cli --locked
	@command -v wasm-opt >/dev/null 2>&1 && echo "wasm-opt already installed" || { \
		echo "Installing binaryen (wasm-opt)..."; \
		if [ "$$(uname)" = "Darwin" ]; then \
			brew install binaryen; \
		else \
			sudo apt-get update && sudo apt-get install -y binaryen; \
		fi; \
	}
	command -v yarn >/dev/null 2>&1 || npm install -g yarn
	yarn --cwd $(WEB_CLIENT_DIR) --silent
	yarn --cwd crates/idxdb-store/src --silent
	yarn --silent
	@echo "Development tools installation complete!"
