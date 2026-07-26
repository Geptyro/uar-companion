#!/usr/bin/env bash
# Full-stack E2E: the CLI (same core code as the Electron app) against the
# real uar-website server with throwaway MongoDB + MinIO containers.
# Needs docker and a ../../website checkout — skips politely otherwise.
set -euo pipefail
cd "$(dirname "$0")/.."
SITE=../website
if [ ! -d "$SITE" ] || ! command -v docker >/dev/null; then
	echo "e2e: needs docker and a ../website checkout — skipping"
	exit 0
fi

T=$(mktemp -d)
MPORT=$((20000 + RANDOM % 10000))
SPORT=$((30000 + RANDOM % 10000))
APPPORT=$((40000 + RANDOM % 10000))
SUFFIX=$$
CLEANUP() {
	docker rm -f "tray-e2e-mongo-$SUFFIX" "tray-e2e-minio-$SUFFIX" >/dev/null 2>&1 || true
	# SIGKILL, not TERM: adapter-node shuts down gracefully and lingers on
	# open connections, which leaves an orphan holding the script's stdout
	[ -n "${SERVER_PID:-}" ] && kill -9 "$SERVER_PID" 2>/dev/null || true
	rm -rf "$T"
}
trap CLEANUP EXIT

echo "· containers (mongo:$MPORT minio:$SPORT app:$APPPORT)"
docker run -d --rm --name "tray-e2e-mongo-$SUFFIX" -p "$MPORT:27017" mongo:7 >/dev/null
docker run -d --rm --name "tray-e2e-minio-$SUFFIX" -p "$SPORT:9000" \
	-e MINIO_ROOT_USER=itkey -e MINIO_ROOT_PASSWORD=itsecret123 \
	quay.io/minio/minio server /data >/dev/null

echo "· building site"
(cd "$SITE" && npm run build --silent >/dev/null)

for i in $(seq 1 30); do
	curl -sf "http://localhost:$SPORT/minio/health/live" >/dev/null && break
	sleep 0.5
done
curl -sf -X PUT -u itkey:itsecret123 --aws-sigv4 "aws:amz:auto:s3" \
	"http://localhost:$SPORT/tray-e2e" -o /dev/null

export MONGODB_URI="mongodb://localhost:$MPORT" MONGODB_DB=tray-e2e
export AWS_ACCESS_KEY_ID=itkey AWS_SECRET_ACCESS_KEY=itsecret123
export AWS_ENDPOINT_URL_S3="http://localhost:$SPORT" BUCKET_NAME=tray-e2e
export PORT=$APPPORT ORIGIN="http://localhost:$APPPORT" BODY_SIZE_LIMIT=16M
(cd "$SITE" && node build) &
SERVER_PID=$!
for i in $(seq 1 30); do
	curl -sf "http://localhost:$APPPORT/" >/dev/null && break
	sleep 0.5
done
curl -sf "http://localhost:$APPPORT/" >/dev/null || {
	echo "e2e: site server did not come up"
	exit 1
}

mkdir -p "$T/replays" "$T/state"
cp testdata/20260723-1808.SC2Replay "$T/replays/Undead Assault reborn.SC2Replay"
cp testdata/20260723-1802.SC2Replay "$T/replays/Undead Assault reborn (2).SC2Replay"
echo "junk" > "$T/replays/Some Other Map.SC2Replay"
touch -d '2 minutes ago' "$T/replays/"* 2>/dev/null || touch -A -02M "$T/replays/"*

FAILS=0
check() {
	if echo "$3" | grep -q "$2"; then echo "  ✔ $1"; else
		echo "  ✖ $1 — expected '$2', got: $3"
		FAILS=$((FAILS + 1))
	fi
}

echo "· run 1 (expect: 1 accepted, 1 rejected no-save-data, 1 unreadable)"
node src/cli.ts --once --spacing 2000 --state "$T/state" \
	--dir "$T/replays" --server "http://localhost:$APPPORT" 2>&1 | sed 's/^/  /'

STATE=$(cat "$T/state/state.json")
check "accepted replay recorded"    '"reason": "uploaded"'  "$STATE"
check "no-save-data replay skipped" 'No player save data'   "$STATE"
check "junk file skipped"           'unreadable replay'     "$STATE"

R=$(curl -s "http://localhost:$APPPORT/replays")
check "site lists the upload" '20260723-1808' "$R"

echo "· run 2 (idempotent: no new posts)"
OUT2=$(node src/cli.ts --once --spacing 2000 --state "$T/state" \
	--dir "$T/replays" --server "http://localhost:$APPPORT" 2>&1)
if echo "$OUT2" | grep -qi 'uploaded\|queued'; then
	echo "  ✖ second run tried to upload:"; echo "$OUT2" | sed 's/^/    /'; FAILS=$((FAILS + 1))
else echo "  ✔ second run uploads nothing"; fi

echo "· fresh state + same files (server-side sha dedupe)"
OUT3=$(node src/cli.ts --once --spacing 2000 --state "$T/state2" \
	--dir "$T/replays" --server "http://localhost:$APPPORT" 2>&1)
check "known sha not re-uploaded" 'already on the server' "$OUT3"

echo
if [ "$FAILS" -gt 0 ]; then echo "E2E FAILED: $FAILS check(s)"; exit 1; fi
echo "e2e: all checks passed"
