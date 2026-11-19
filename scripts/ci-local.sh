#!/usr/bin/env bash
# Runs the full check on this machine against a local SAP HANA Express:
# typecheck, unit tests, build, the HANA connection check and every integration test
# (HANA_ORM_ALLOW_DDL=1). It fails if any integration test was skipped. With --bench it also
# runs the HANA benchmark. These steps do not run in GitHub Actions.
#
#   npm run ci:local                 # uses .env.test
#   npm run ci:local -- --bench
#   HANA_ORM_ENV_FILE=.env.other npm run ci:local
#
# If HANA does not answer and a stopped container named $HANA_CONTAINER (default: hxe, then
# hana-orm-hxe) exists, the script starts it and waits for it. Logs go to .local/ci/.
set -euo pipefail
cd "$(dirname "$0")/.."

bench=0
for arg in "$@"; do
  case "$arg" in
    --bench) bench=1 ;;
    -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

export HANA_ORM_ENV_FILE="${HANA_ORM_ENV_FILE:-.env.test}"
export HANA_ORM_ALLOW_DDL=1
if [ ! -f "$HANA_ORM_ENV_FILE" ]; then
  echo "No $HANA_ORM_ENV_FILE. Create it with HANA_HOST, HANA_PORT, HANA_USER, HANA_PASSWORD (and HANA_DATABASE)," >&2
  echo "see docker-compose.hana.yml." >&2
  exit 1
fi

logs=.local/ci
mkdir -p "$logs"
step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

step "Typecheck"
npm run typecheck
step "Unit tests"
npm test 2>&1 | tee "$logs/unit.log" | grep -E '^ℹ (tests|pass|fail)|^✖' || true
grep -Eq '^ℹ fail 0$' "$logs/unit.log" || { echo "Unit tests failed, see $logs/unit.log" >&2; exit 1; }
step "Build"
npm run build >/dev/null

step "HANA connection"
if ! node scripts/check-hana.ts 2>/dev/null; then
  container=""
  for name in ${HANA_CONTAINER:-hxe hana-orm-hxe}; do
    if docker inspect "$name" >/dev/null 2>&1; then container=$name; break; fi
  done
  if [ -z "$container" ]; then
    node scripts/check-hana.ts || true
    echo "HANA does not answer and no HANA container was found. Start one (docker-compose.hana.yml) or set HANA_CONTAINER." >&2
    exit 1
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != "true" ]; then
    echo "Starting container $container"
    docker start "$container" >/dev/null
  fi
  echo "Waiting for HANA in $container (up to 15 minutes)"
  for i in $(seq 1 90); do
    if node scripts/check-hana.ts 2>/dev/null; then break; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != "true" ]; then
      echo "The container stopped" >&2; docker logs --tail 50 "$container" >&2; exit 1
    fi
    if [ "$i" = 90 ]; then
      echo "HANA did not answer within 15 minutes" >&2; docker logs --tail 50 "$container" >&2; exit 1
    fi
    sleep 10
  done
fi

step "Integration tests"
npm run test:integration 2>&1 | tee "$logs/integration.log" | grep -E '^ℹ (tests|pass|fail|skipped)|^✖' || true
grep -Eq '^ℹ fail 0$' "$logs/integration.log" || { echo "Integration tests failed, see $logs/integration.log" >&2; exit 1; }
# skipped tests would make a green run meaningless: every test must have run
grep -Eq '^ℹ skipped 0$' "$logs/integration.log" || { echo "Some integration tests were skipped, see $logs/integration.log" >&2; exit 1; }

if [ "$bench" = 1 ]; then
  step "Benchmarks"
  node bench/hana/run.ts --out "$logs/bench-results.json" --md "$logs/bench-results.md"
fi

printf '\n\033[1;32m✔ All checks passed\033[0m (logs in %s)\n' "$logs"
