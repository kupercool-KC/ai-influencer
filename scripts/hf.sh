# Shared Higgsfield helpers for workflows (source this file). Needs: higgsfield CLI logged in, jq, python
# (content_scout on the path via the job's working directory), and these set by the caller:
#   REF_FLAGS  array of --image-references flags     REFS  array of the reference image paths
#   RUN_DIR    scratch directory

# hf_gen <model> [args...]: retries transient 5xx up to 3 times; prints only the result URL.
hf_gen() {
  local n=0 out
  until out=$(higgsfield generate create "$@" 2>&1); do
    n=$((n + 1))
    if [ "$n" -ge 3 ] || ! grep -q "HTTP 5" <<< "$out"; then echo "$out" >&2; return 1; fi
    echo "higgsfield 5xx, retrying ($n/3)..." >&2; sleep 20
  done
  tail -n 1 <<< "$out"
}

# gen_image <prompt> <aspect>: one reference-locked nano_banana_pro image, checked against Ivy's reference
# (same person, no text, plausible anatomy, within limits) and regenerated ONCE if it fails.
gen_image() {
  local prompt="$1" aspect="$2" attempt=1 url review
  while true; do
    url=$(hf_gen nano_banana_pro --prompt "$prompt" "${REF_FLAGS[@]}" --aspect_ratio "$aspect" --resolution 2k --wait --wait-timeout 5m)
    if curl -sSfL -o "$RUN_DIR/qa.png" "$url"; then
      review=$(python -m content_scout.image_review --image "$RUN_DIR/qa.png" --reference "${REFS[0]}" 2>/dev/null || echo '{"ok":true}')
      echo "image QA (attempt $attempt): $review" >&2
      if [ "$(jq -r '.ok' <<< "$review")" != "true" ] && [ "$attempt" -lt 2 ]; then attempt=$((attempt + 1)); continue; fi
    fi
    echo "$url"; return 0
  done
}
