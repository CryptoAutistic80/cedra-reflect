.PHONY: verify conformance-check move-test python-test ts-test pilot-gate release-artifacts

# The system Cedra CLI is the reviewed v1.0.4 binary. Node's bin directory can
# contain an unrelated `cedra` executable, so do not resolve this through PATH.
CEDRA ?= /usr/bin/cedra

verify: conformance-check move-test python-test ts-test

conformance-check:
	PYTHONPATH=python python3 scripts/generate_seeded_conformance.py --check

move-test:
	cd move/hook-probe && $(CEDRA) move test --skip-fetch-latest-git-deps
	cd move/reflection-core && $(CEDRA) move test --skip-fetch-latest-git-deps
	cd move/test-assets && $(CEDRA) move test --skip-fetch-latest-git-deps
	cd move/test-amm && $(CEDRA) move test --skip-fetch-latest-git-deps
	cd move/integration-tests && $(CEDRA) move test --skip-fetch-latest-git-deps

python-test:
	PYTHONPATH=python python3 -m unittest discover -s python/tests -v

ts-test:
	PATH=/home/james/.nvm/versions/node/v24.11.1/bin:$$PATH npm test

pilot-gate:
	REFLECTION_MODEL_OPERATIONS=1000000 REFLECTION_MODEL_HOLDERS=1024 PYTHONPATH=python python3 -m unittest python.tests.test_accounting_model.RandomizedPropertyTests.test_seeded_randomized_accounting -v

release-artifacts:
	CEDRA_BIN=$(CEDRA) bash scripts/verify_release_artifacts.sh
