#!/usr/bin/env bash
# Run the gate, record its outcome, and leave failing the job to the last step so the report is always uploaded.
set -uo pipefail

out="$RUNNER_TEMP/pincheck"
report="$out/report.json"
args=(gate --base "$BASE_FILE" --head "$HEAD_FILE" --report "$report" --manifest-path "$MANIFEST")
[[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && args+=(--summary "$GITHUB_STEP_SUMMARY")
[[ -n "${SITE_URL:-}" ]] && args+=(--site-url "$SITE_URL")

node "$GITHUB_ACTION_PATH/cli.mjs" "${args[@]}"
code=$?

decision=inconclusive
if [[ -s "$report" ]]; then
  decision=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).decision)' "$report" 2>/dev/null || echo inconclusive)
  echo "report=$report" >> "$GITHUB_OUTPUT"
fi
case "$code" in
  0) ;;
  1) echo "::error title=PinCheck::A pinned circuit changed behavior. See the job summary for the counterexample." ;;
  *) echo "::error title=PinCheck::The circuit check did not complete, so the merge is blocked. See the job summary." ;;
esac
{
  echo "decision=$decision"
  echo "exit-code=$code"
} >> "$GITHUB_OUTPUT"
exit 0
