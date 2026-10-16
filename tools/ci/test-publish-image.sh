#!/bin/sh
# Offline registry/git fixtures: never calls a real daemon, registry or remote.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT HUP INT TERM
mkdir "$fixture/bin"
cat > "$fixture/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FIXTURE_LOG"
[ "$1 $2 $3" = 'buildx imagetools inspect' ] || exit 0
ref=$4
case "$ref" in
    *-amd64|*@sha256:aaaa*) arch=amd64 ;;
    *-arm64|*@sha256:bbbb*) arch=arm64 ;;
    *) exit 90 ;;
esac
if [ "$#" -eq 4 ]; then
    case "$arch" in
        amd64) digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
        arm64) digest=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
    esac
    printf 'Name: fixture\nDigest: sha256:%s\n' "$digest"
    exit
fi
case "$6" in
    *Architecture*)
        if [ "$arch" = arm64 ] && [ "${BAD_ARM:-}" = platform ]; then echo linux/amd64; else echo linux/$arch; fi ;;
    *org.opencontainers.image.revision*)
        if [ "$arch" = arm64 ] && [ "${BAD_ARM:-}" = revision ]; then echo oldcommit; else echo "$CI_COMMIT_SHA"; fi ;;
    *io.wearmux.profile*)
        if [ "$arch" = arm64 ] && [ "${BAD_ARM:-}" = profile ]; then echo native-ble; else echo "$IMAGE_PROFILE"; fi ;;
    *Config.Env*)
        if [ "$arch" = arm64 ] && [ "${BAD_ARM:-}" = commit ]; then echo COMMIT=oldcommit; else echo COMMIT=$CI_COMMIT_SHORT_SHA; fi
        if [ "$IMAGE_PROFILE" = android-ble ] && [ "${BAD_ARM:-}" != transport ]; then echo DEVICE_TRANSPORT=android-ble; fi ;;
    *Config.Cmd*)
        if [ "$IMAGE_PROFILE" = native-ble ] || [ "${BAD_ARM:-}" = cmd ]; then printf 'node\ntools/launcher.js\n'; else printf 'node\ntools/sessions.js\n'; fi ;;
    *) exit 91 ;;
esac
MOCK
cat > "$fixture/bin/git" <<'MOCK'
#!/bin/sh
set -eu
if [ "${GIT_FAIL:-}" = yes ]; then echo 'private credential error should be hidden' >&2; exit 1; fi
printf '%s\trefs/heads/%s\n' "${REMOTE_SHA:-$CI_COMMIT_SHA}" "$CI_COMMIT_BRANCH"
MOCK
chmod +x "$fixture/bin/docker" "$fixture/bin/git"
export PATH="$fixture/bin:$PATH" FIXTURE_LOG="$fixture/log"
export CI_REGISTRY_IMAGE=registry.example/headless CI_PIPELINE_ID=12345
export CI_COMMIT_SHA=0123456789012345678901234567890123456789 CI_COMMIT_SHORT_SHA=01234567
export IMAGE_PROFILE=android-ble CI_COMMIT_TAG='' CI_COMMIT_BRANCH=feature-android-bluetooth
export CI_REPOSITORY_URL=https://example.invalid/repository PUBLISH_TAG=feature-android-bluetooth

run() {
    : > "$FIXTURE_LOG"
    sh "$script_dir/publish-image.sh" publish > "$fixture/output" 2>&1
}
refuse() {
    if run; then echo "FAIL: accepted $1" >&2; exit 1; fi
    if grep -q 'imagetools create' "$FIXTURE_LOG"; then echo "FAIL: published despite $1" >&2; exit 1; fi
}

run
grep -Fq -- "-t $CI_REGISTRY_IMAGE:sha-$CI_COMMIT_SHA-android-ble" "$FIXTURE_LOG"
grep -q -- "-t $CI_REGISTRY_IMAGE:$PUBLISH_TAG" "$FIXTURE_LOG"
[ "$(grep -c 'imagetools create' "$FIXTURE_LOG")" -eq 2 ]
grep 'imagetools create' "$FIXTURE_LOG" | grep -q '@sha256:'
if grep -q ':feature-android-bluetooth-arm64' "$FIXTURE_LOG"; then exit 1; fi
echo 'PASS: matching native-platform images publish from pipeline-owned digests'

for BAD_ARM in revision commit platform profile transport cmd; do
    export BAD_ARM
    refuse "$BAD_ARM mismatch"
    echo "PASS: rejects $BAD_ARM mismatch before publication"
done
unset BAD_ARM

export REMOTE_SHA=ffffffffffffffffffffffffffffffffffffffff
run
[ "$(grep -c 'imagetools create' "$FIXTURE_LOG")" -eq 1 ]
if grep -q -- "-t $CI_REGISTRY_IMAGE:$PUBLISH_TAG" "$FIXTURE_LOG"; then exit 1; fi
echo 'PASS: stale branch preserves commit artifact and skips friendly publication'
unset REMOTE_SHA

export GIT_FAIL=yes
if run; then echo 'FAIL: accepted failed remote-tip lookup' >&2; exit 1; fi
[ "$(grep -c 'imagetools create' "$FIXTURE_LOG")" -eq 1 ]
if grep -q 'private credential' "$fixture/output"; then echo 'FAIL: exposed git stderr' >&2; exit 1; fi
echo 'PASS: remote-tip failure does not publish friendly tag or expose git stderr'
unset GIT_FAIL

export CI_COMMIT_TAG=v1.2.3 PUBLISH_TAG=v1.2.3 IMAGE_PROFILE=native-ble GIT_FAIL=yes
run
[ "$(grep -c 'imagetools create' "$FIXTURE_LOG")" -eq 2 ]
grep -q -- "-t $CI_REGISTRY_IMAGE:v1.2.3" "$FIXTURE_LOG"
echo 'PASS: tag pipeline keeps native profile and needs no branch lookup'
