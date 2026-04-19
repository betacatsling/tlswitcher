#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RAY_BIN="$ROOT_DIR/node_modules/.bin/ray"
PID_FILE="$ROOT_DIR/.raycast-dev.pid"
LOG_FILE="$ROOT_DIR/.raycast-dev.log"
BUILD_DIR="$ROOT_DIR/build"

cd "$ROOT_DIR"

if [[ ! -x "$RAY_BIN" ]]; then
  npm install
fi

if [[ ! -x "$RAY_BIN" ]]; then
  print -u2 -- "Raycast CLI is missing. Run npm install and try again."
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(<"$PID_FILE")"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
    kill "$OLD_PID" >/dev/null 2>&1 || true
    sleep 0.5
  fi
  rm -f "$PID_FILE"
fi

npm install
"$RAY_BIN" lint --fix --non-interactive --exit-on-error
"$RAY_BIN" build --non-interactive --exit-on-error --environment dist --output "$BUILD_DIR"

nohup "$RAY_BIN" develop --non-interactive >"$LOG_FILE" 2>&1 &
print -r -- "$!" > "$PID_FILE"

for _ in {1..20}; do
  if rg -q 'Unable to install extension|Development session couldn'\''t start|inability to install from local sources' "$LOG_FILE" 2>/dev/null; then
    cat "$LOG_FILE" >&2
    rm -f "$PID_FILE"
    exit 1
  fi

  if rg -q 'ready  - built extension successfully' "$LOG_FILE" 2>/dev/null; then
    break
  fi

  sleep 0.5
done

open -a Raycast >/dev/null 2>&1 || true

print -r -- "TLSwitcher built and loaded into Raycast dev mode."
print -r -- "Project: $ROOT_DIR"
print -r -- "Build: $BUILD_DIR"
print -r -- "Dev PID: $(<"$PID_FILE")"
print -r -- "Log: $LOG_FILE"
