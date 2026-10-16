#!/bin/sh
# Run in a GitLab resource_group: image-publication-$CI_COMMIT_REF_SLUG.
set -eu

fail() { echo "Image publication refused: $*" >&2; exit 1; }

verify_image() {
    verify_ref=$1
    verify_arch=$2
    platform=$(docker buildx imagetools inspect "$verify_ref" --format '{{.Image.OS}}/{{.Image.Architecture}}')
    [ "$platform" = "linux/$verify_arch" ] || fail "expected linux/$verify_arch, found $platform"
    revision=$(docker buildx imagetools inspect "$verify_ref" --format '{{index .Image.Config.Labels "org.opencontainers.image.revision"}}')
    [ "$revision" = "$CI_COMMIT_SHA" ] || fail "revision mismatch for $verify_arch"
    profile=$(docker buildx imagetools inspect "$verify_ref" --format '{{index .Image.Config.Labels "io.wearmux.profile"}}')
    [ "$profile" = "$IMAGE_PROFILE" ] || fail "profile mismatch for $verify_arch"
    image_env=$(docker buildx imagetools inspect "$verify_ref" --format '{{range .Image.Config.Env}}{{println .}}{{end}}')
    printf '%s\n' "$image_env" | grep -Fxq "COMMIT=$CI_COMMIT_SHORT_SHA" || fail "COMMIT mismatch for $verify_arch"
    image_cmd=$(docker buildx imagetools inspect "$verify_ref" --format '{{range .Image.Config.Cmd}}{{println .}}{{end}}')
    case "$IMAGE_PROFILE" in
        android-ble)
            printf '%s\n' "$image_env" | grep -Fxq 'DEVICE_TRANSPORT=android-ble' || fail "missing Android transport for $verify_arch"
            expected_cmd=$(printf 'node\ntools/sessions.js')
            ;;
        native-ble)
            if printf '%s\n' "$image_env" | grep -Fxq 'DEVICE_TRANSPORT=android-ble'; then
                fail "Android transport in native image for $verify_arch"
            fi
            expected_cmd=$(printf 'node\ntools/launcher.js')
            ;;
        *) fail "unsupported profile" ;;
    esac
    [ "$image_cmd" = "$expected_cmd" ] || fail "entry command mismatch for $verify_arch"
}

digest_ref() {
    # Resolve once and validate the digest, then inspect and publish by digest.
    digest_output=$(docker buildx imagetools inspect "$1")
    digest=$(printf '%s\n' "$digest_output" | awk '$1 == "Digest:" {print $2; exit}')
    printf '%s\n' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "invalid digest for staging image"
    printf '%s@%s\n' "$CI_REGISTRY_IMAGE" "$digest"
}

: "${CI_REGISTRY_IMAGE:?}" "${CI_PIPELINE_ID:?}" "${CI_COMMIT_SHA:?}" "${CI_COMMIT_SHORT_SHA:?}" "${IMAGE_PROFILE:?}"
case "${1:-}" in
    verify) verify_image "$2" "$3"; exit ;;
    publish) ;;
    *) fail "usage: publish-image.sh publish|verify REF ARCH" ;;
esac

amd64_ref=$(digest_ref "$CI_REGISTRY_IMAGE:ci-$CI_PIPELINE_ID-amd64")
arm64_ref=$(digest_ref "$CI_REGISTRY_IMAGE:ci-$CI_PIPELINE_ID-arm64")
verify_image "$amd64_ref" amd64
verify_image "$arm64_ref" arm64

# Includes the profile because tag pipelines use the normal Dockerfile even when
# the same revision was built on the Android feature branch.
commit_ref="$CI_REGISTRY_IMAGE:sha-$CI_COMMIT_SHA-$IMAGE_PROFILE"
docker buildx imagetools create -t "$commit_ref" "$amd64_ref" "$arm64_ref"

if [ -z "${CI_COMMIT_TAG:-}" ]; then
    command -v git >/dev/null 2>&1 || fail 'git is required to verify the remote branch tip'
    : "${CI_REPOSITORY_URL:?}" "${CI_COMMIT_BRANCH:?}"
    # CI_REPOSITORY_URL contains credentials; do not print it or git stderr.
    if ! branch_tip=$(git ls-remote --exit-code "$CI_REPOSITORY_URL" "refs/heads/$CI_COMMIT_BRANCH" 2>/dev/null); then
        fail 'could not read the remote branch tip'
    fi
    branch_sha=$(printf '%s\n' "$branch_tip" | awk 'NR == 1 {print $1}')
    if [ "$branch_sha" != "$CI_COMMIT_SHA" ]; then
        echo 'Skipping friendly branch tag: this pipeline is no longer the branch tip.'
        exit 0
    fi
fi

: "${PUBLISH_TAG:?}"
docker buildx imagetools create -t "$CI_REGISTRY_IMAGE:$PUBLISH_TAG" "$amd64_ref" "$arm64_ref"
