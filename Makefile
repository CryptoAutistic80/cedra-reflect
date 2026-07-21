.PHONY: contract-verify verify conformance-check move-lint move-test python-test ts-test release-tooling-test schema-check release-closure-check pilot-gate release-artifacts clean-release-verification exact-address-artifacts exact-address-artifacts-from-candidate validate-public-role-candidate assemble-testnet-candidate

# The system Cedra CLI is the reviewed v1.0.4 binary. Node's bin directory can
# contain an unrelated `cedra` executable, so do not resolve this through PATH.
CEDRA ?= /usr/bin/cedra
MOVE_DEV_ADDRESSES := reflection_core=0xcafe,test_assets=0xbabe,test_amm=0xdead

define strict_move_lint
	@set -eu; \
		lint_log="$$(mktemp /tmp/cedra-reflect-lint.XXXXXX)"; \
		trap 'rm -f "$$lint_log"' EXIT; \
		if ! $(CEDRA) move lint --package-dir $(1) --named-addresses $(MOVE_DEV_ADDRESSES) --skip-fetch-latest-git-deps >"$$lint_log" 2>&1; then \
			cat "$$lint_log"; \
			exit 1; \
		fi; \
		cat "$$lint_log"; \
		if grep -Fq 'warning: [lint]' "$$lint_log"; then \
			echo "Move lint warning rejected for $(1)" >&2; \
			exit 1; \
		fi
endef

# Authoritative completion gate for the on-chain package. It intentionally
# excludes the optional UI, TypeScript SDK/indexer, release-candidate ceremony,
# profiles, and live Testnet operations. The randomized model gate defaults to
# one million successfully applied state transitions.
contract-verify: conformance-check move-lint move-test python-test pilot-gate

# Broader repository/release-tooling verification. This is not the definition
# of contract completion; it additionally exercises off-chain tooling.
verify: conformance-check move-lint move-test python-test ts-test release-tooling-test schema-check release-closure-check

conformance-check:
	PYTHONPATH=python python3 scripts/generate_seeded_conformance.py --check

move-lint:
	$(call strict_move_lint,move/reflection-core)
	$(call strict_move_lint,move/test-assets)
	$(call strict_move_lint,move/test-amm)

move-test:
	cd move/hook-probe && $(CEDRA) move test --skip-fetch-latest-git-deps
	cd move/reflection-core && $(CEDRA) move test --skip-fetch-latest-git-deps
	cd move/test-assets && $(CEDRA) move test --skip-fetch-latest-git-deps
	cd move/test-amm && $(CEDRA) move test --skip-fetch-latest-git-deps
	cd move/integration-tests && $(CEDRA) move test --skip-fetch-latest-git-deps

python-test:
	PYTHONPATH=python python3 -m unittest discover -s python/tests -v

ts-test:
	TMPDIR=/tmp TEMP=/tmp TMP=/tmp \
		PATH=/home/james/.nvm/versions/node/v24.11.1/bin:$$PATH npm test

release-tooling-test:
	bash scripts/test_release_tooling.sh

schema-check:
	python3 scripts/check_json_schemas.py \
		ops/schemas/approval-envelope.schema.json \
		ops/schemas/transaction-build-request.schema.json \
		ops/schemas/transaction-evidence.schema.json \
		ops/schemas/release-manifest.schema.json \
		ops/schemas/sdk-review-attestation.schema.json \
		ops/schemas/release-executable-closure.schema.json

release-closure-check:
	@test -n "$(RELEASE_NODE_RUNTIME)" || \
		{ echo "set RELEASE_NODE_RUNTIME to the explicit reviewed Node.js binary" >&2; exit 64; }
	bash scripts/check_release_executable_closure.sh "$(CURDIR)" "$(RELEASE_NODE_RUNTIME)"

pilot-gate:
	REFLECTION_MODEL_OPERATIONS=$${REFLECTION_MODEL_OPERATIONS:-1000000} \
	REFLECTION_MODEL_HOLDERS=$${REFLECTION_MODEL_HOLDERS:-1024} \
	PYTHONPATH=python python3 scripts/run_model_gate.py

release-artifacts:
	CEDRA_BIN=$(CEDRA) bash scripts/verify_release_artifacts.sh

clean-release-verification:
	@test -n "$(OUTPUT_DIRECTORY)" || \
		{ echo "set OUTPUT_DIRECTORY (use /tmp or ignored ops/local)" >&2; exit 64; }
	CEDRA_BIN=$(CEDRA) bash scripts/capture_clean_release_verification.sh "$(OUTPUT_DIRECTORY)"

exact-address-artifacts:
	@test -n "$(CORE_ADDRESS)" -a -n "$(ASSETS_ADDRESS)" -a -n "$(AMM_ADDRESS)" \
		-a -n "$(OPERATIONS_ADDRESS)" -a -n "$(BOOTSTRAP_LP_ADDRESS)" -a -n "$(OUTPUT_DIRECTORY)" || \
		{ echo "set CORE_ADDRESS, ASSETS_ADDRESS, AMM_ADDRESS, OPERATIONS_ADDRESS, BOOTSTRAP_LP_ADDRESS, and OUTPUT_DIRECTORY" >&2; exit 64; }
	CEDRA_BIN=$(CEDRA) RELEASE_VERIFICATION_RECORD="$(RELEASE_VERIFICATION_RECORD)" \
		bash scripts/prepare_exact_address_release.sh \
		"$(CORE_ADDRESS)" "$(ASSETS_ADDRESS)" "$(AMM_ADDRESS)" \
		"$(OPERATIONS_ADDRESS)" "$(BOOTSTRAP_LP_ADDRESS)" "$(OUTPUT_DIRECTORY)"

validate-public-role-candidate:
	bash scripts/validate_release_evidence.sh ops/testnet-roles.candidate.json

exact-address-artifacts-from-candidate: validate-public-role-candidate
	@test -n "$(OUTPUT_DIRECTORY)" || \
		{ echo "set OUTPUT_DIRECTORY (use /tmp or ignored ops/local)" >&2; exit 64; }
	CEDRA_BIN=$(CEDRA) RELEASE_VERIFICATION_RECORD="$(RELEASE_VERIFICATION_RECORD)" \
		bash scripts/prepare_exact_address_release_from_roles.sh \
		"$(ROLE_FILE)" "$(OUTPUT_DIRECTORY)"

assemble-testnet-candidate:
	@test -n "$(EXACT_ADDRESS_ARTIFACTS)" -a -n "$(PUBLIC_PROFILE_EVIDENCE)" \
		-a -n "$(BUILD_REQUEST)" -a -n "$(OUTPUT_DIRECTORY)" \
		-a -n "$(RELEASE_NODE_RUNTIME)" -a -n "$(RELEASE_EMITTED_JS_DIRECTORY)" -a -n "$(SDK_REVIEW_ATTESTATION)" \
		-a -n "$(SDK_REVIEW_SIGNATURE)" -a -n "$(SDK_REVIEW_TRUSTED_SIGNERS)" || \
		{ echo "set exact/profile/request/output plus RELEASE_NODE_RUNTIME, RELEASE_EMITTED_JS_DIRECTORY, and all three SDK_REVIEW_* paths" >&2; exit 64; }
	/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C TMPDIR=/tmp \
	RELEASE_NODE_RUNTIME="$(RELEASE_NODE_RUNTIME)" \
	RELEASE_EMITTED_JS_DIRECTORY="$(RELEASE_EMITTED_JS_DIRECTORY)" \
	SDK_REVIEW_ATTESTATION="$(SDK_REVIEW_ATTESTATION)" \
	SDK_REVIEW_SIGNATURE="$(SDK_REVIEW_SIGNATURE)" \
	SDK_REVIEW_TRUSTED_SIGNERS="$(SDK_REVIEW_TRUSTED_SIGNERS)" \
		/usr/bin/bash --noprofile --norc scripts/run_candidate_assembler.sh \
		"$(EXACT_ADDRESS_ARTIFACTS)" "$(PUBLIC_PROFILE_EVIDENCE)" \
		"$(BUILD_REQUEST)" "$(OUTPUT_DIRECTORY)"

ROLE_FILE ?= ops/testnet-roles.candidate.json
