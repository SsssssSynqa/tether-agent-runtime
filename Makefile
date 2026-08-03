# SPDX-License-Identifier: Apache-2.0

.PHONY: check check-all core-check runtime-test protocol-test export-check public-check markdown-check console-check console-backend-test console-frontend-test

check: core-check

check-all: core-check console-check

core-check: runtime-test protocol-test export-check public-check markdown-check

runtime-test:
	npm test

protocol-test:
	node scripts/probe-selfsame-protocol.cjs

export-check:
	npm run verify:export

public-check:
	scripts/check-public-snapshot

markdown-check:
	node scripts/check-markdown-links.cjs

console-check: console-backend-test console-frontend-test

console-backend-test:
	PYTHONPATH=console/backend python3 -m pytest console/backend/tests/test_tether_console.py

console-frontend-test:
	cd console/frontend && pnpm test && pnpm check && pnpm build
