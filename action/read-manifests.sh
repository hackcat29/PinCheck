#!/usr/bin/env bash
# Fetch the manifest at the base and head commits through the GitHub contents API.
set -euo pipefail

out="$RUNNER_TEMP/pincheck"
mkdir -p "$out"

case "$EVENT_NAME" in
  pull_request|pull_request_target) base_sha="$PR_BASE"; head_sha="$PR_HEAD" ;;
  merge_group) base_sha="$MG_BASE"; head_sha="$MG_HEAD"; PR_HEAD_REPO="" ;;
  *) echo "::error title=PinCheck::PinCheck runs on pull_request and merge_group events, not $EVENT_NAME."; exit 2 ;;
esac
if ! [[ "$MANIFEST" =~ ^[A-Za-z0-9._/-]+$ ]] || [[ "$MANIFEST" == /* || "$MANIFEST" == *..* ]]; then
  echo "::error title=PinCheck::manifest must be a relative path inside the repository."; exit 2
fi

# Prints the HTTP status; writes the body to $3.
fetch() {
  curl --silent --show-error --location --max-time 30 --max-filesize 1048576 \
    --header "Authorization: Bearer $GH_TOKEN" --header "Accept: application/vnd.github.raw" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    --output "$3" --write-out '%{http_code}' \
    "${GITHUB_API_URL:-https://api.github.com}/repos/$1/contents/$MANIFEST?ref=$2" || echo 000
}

read_manifest() { # label sha file
  local status
  status=$(fetch "$REPOSITORY" "$2" "$3")
  if [[ "$status" == 404 && -n "${PR_HEAD_REPO:-}" && "$PR_HEAD_REPO" != "$REPOSITORY" && "$1" == head ]]; then
    status=$(fetch "$PR_HEAD_REPO" "$2" "$3")   # head commit of a fork
  fi
  case "$status" in
    200) echo found ;;
    404) rm -f "$3"; echo missing ;;
    *) echo "::error title=PinCheck::Could not read $MANIFEST at the $1 commit (HTTP $status). Grant the job contents: read." >&2; exit 2 ;;
  esac
}

base_state=$(read_manifest base "$base_sha" "$out/base.json")
head_state=$(read_manifest head "$head_sha" "$out/head.json")
if [[ "$head_state" == missing ]]; then
  printf '{"pincheck":1,"dependencies":{}}\n' > "$out/head.json"
  echo "::warning title=PinCheck::$MANIFEST is missing at the head commit; every dependency is treated as removed."
fi

{
  echo "base=$([[ "$base_state" == found ]] && echo "$out/base.json" || echo none)"
  echo "head=$out/head.json"
  echo "base-sha=$base_sha"
  echo "head-sha=$head_sha"
} >> "$GITHUB_OUTPUT"
echo "Read $MANIFEST at base ${base_sha:0:12} ($base_state) and head ${head_sha:0:12} ($head_state)"
