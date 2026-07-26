#!/usr/bin/env bash
# Tail every Raphael service log as ONE stream, each line tagged with its service.
#
#   ./logs.sh                      # all services
#   ./logs.sh gateway              # one service
#   ./logs.sh gateway agent-svc    # a few
#   ./logs.sh -n 200               # start with 200 lines of history (default 20)
#
# Trace one request end to end across all services:
#   ./logs.sh -n 5000 | grep 3f9c1a2b            # the request_id
# Only errors:
#   ./logs.sh | grep -E 'ERROR|"level":"error"'
#
# Lines that are JSON get pretty-printed (time, LEVEL, msg, then the remaining
# fields as key=val). Anything that is not JSON — Next.js dev output, a Go panic,
# a stack trace — is passed through verbatim. jq is optional: without it every
# line is raw. Colour is emitted only to a TTY, so piping to grep stays clean.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$ROOT/logs"

TAIL_N=20
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -n) TAIL_N="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *)  ARGS+=("$1"); shift ;;
  esac
done

FILES=()
if [ "${#ARGS[@]}" -gt 0 ]; then
  for a in "${ARGS[@]}"; do
    f="$LOGS/${a%.log}.log"
    [ -f "$f" ] || { echo "no such log: $f" >&2; exit 1; }
    FILES+=("$f")
  done
else
  for f in "$LOGS"/*.log; do [ -f "$f" ] && FILES+=("$f"); done
fi
[ "${#FILES[@]}" -gt 0 ] || { echo "no logs in $LOGS — start the stack with ./dev.sh" >&2; exit 1; }

TTY=0; [ -t 1 ] && TTY=1
COLORS=($'\033[36m' $'\033[32m' $'\033[35m' $'\033[33m' $'\033[34m' $'\033[31m')
Z=$'\033[0m'

HAVE_JQ=0; command -v jq >/dev/null 2>&1 && HAVE_JQ=1

# JSON line -> "12:04:31 INFO  msg  key=val ...". Non-JSON falls through as-is:
# the whole program is `(...) // .`, and jq's // yields the right side when the
# left produces no output (fromjson? on a non-JSON line produces nothing).
JQ_FMT='
  ( fromjson?
    | select(type == "object")
    | ( (.time // .timestamp // "") | tostring | sub("^.*T"; "") | sub("([.+Z].*)$"; "") ) as $t
    | ( (.level // "-") | tostring | ascii_upcase ) as $lvl
    | ( .msg // .message // "" | tostring ) as $m
    | ( del(.time, .timestamp, .level, .msg, .message, .service)
        | to_entries
        | map("\(.key)=\(.value | if type == "string" then . else tojson end)")
        | join(" ") ) as $rest
    | "\($t) \($lvl) \($m)" + (if $rest == "" then "" else "  " + $rest end)
  ) // .
'

trap 'kill 0 2>/dev/null' INT TERM

i=0
for f in "${FILES[@]}"; do
  name="$(basename "$f" .log)"
  if [ "$TTY" = 1 ]; then c="${COLORS[$((i % ${#COLORS[@]}))]}"; e="$Z"; else c=""; e=""; fi
  i=$((i + 1))
  {
    if [ "$HAVE_JQ" = 1 ]; then
      tail -n "$TAIL_N" -F "$f" 2>/dev/null | jq -Rr --unbuffered "$JQ_FMT"
    else
      tail -n "$TAIL_N" -F "$f" 2>/dev/null
    fi
  } | while IFS= read -r line; do
        printf '%s%-9s%s | %s\n' "$c" "$name" "$e" "$line"
      done &
done

wait
