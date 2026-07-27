#!/usr/bin/env bash
set -u

PROJECT_ROOT="${1:-$PWD}"
OUTPUT="${2:-$PROJECT_ROOT/sandbox-manual-test.log}"
CLIPBOARD_FIXTURE="${3:-}"
PROJECT_PROBE="$PROJECT_ROOT/.pi-bwrap-project-probe-$$"
CHILD_PROBE="$PROJECT_ROOT/.pi-bwrap-child-probe-$$"
HOST_TMP_PROBE="/tmp/pi-bwrap-host-probe-$$"
GIT_PROBE="$PROJECT_ROOT/.git/pi-bwrap-probe-$$"
PRIVATE_TMP_PROBE="${TMPDIR:-}/pi-bwrap-private-probe-$$"
SIGNING_REPO=""

rm -f "$PROJECT_PROBE" "$CHILD_PROBE" "$OUTPUT"
exec > >(tee "$OUTPUT") 2>&1

passed=0
failed=0

pass() {
  passed=$((passed + 1))
  printf 'PASS: %s\n' "$1"
}

fail() {
  failed=$((failed + 1))
  printf 'FAIL: %s\n' "$1"
}

cleanup() {
  rm -f "$PROJECT_PROBE" "$CHILD_PROBE" "$PRIVATE_TMP_PROBE"
  if [ -e "$HOST_TMP_PROBE" ]; then rm -f "$HOST_TMP_PROBE"; fi
  if [ -e "$GIT_PROBE" ]; then rm -f "$GIT_PROBE"; fi
  if [ -n "$SIGNING_REPO" ] && [ -e "$SIGNING_REPO" ]; then rm -rf "$SIGNING_REPO"; fi
}
trap cleanup EXIT

printf 'Linux Bubblewrap manual integration test\n'
printf 'Project: %s\n' "$PROJECT_ROOT"
printf 'TMPDIR: %s\n' "${TMPDIR:-unset}"
printf 'Output: %s\n\n' "$OUTPUT"

if [ -n "${TMPDIR:-}" ] && [ -d "$TMPDIR" ]; then
  pass 'private TMPDIR exists'
else
  fail 'private TMPDIR exists'
fi

if printf 'private-temp-ok\n' > "$PRIVATE_TMP_PROBE" && grep -q '^private-temp-ok$' "$PRIVATE_TMP_PROBE"; then
  pass 'private TMPDIR is writable'
else
  fail 'private TMPDIR is writable'
fi

resource_root=${TMPDIR%/*}
unexpected_resource=$(find "$resource_root" -mindepth 1 -maxdepth 1 ! -name tmp -print -quit 2>&1)
if [ -z "$unexpected_resource" ]; then
  pass 'trusted runtime resource sources are hidden behind the TMPDIR parent'
else
  fail "trusted runtime resource sources are hidden: $unexpected_resource"
fi

ssh_config_identity=$(stat -c '%u:%a' /etc/ssh/ssh_config 2>&1)
if [ "$ssh_config_identity" = "$(id -u):600" ] && [ ! -w /etc/ssh/ssh_config ]; then
  pass 'generated OpenSSH system config is exact and read-only'
else
  fail "generated OpenSSH system config is exact and read-only: $ssh_config_identity"
fi

ssh_parse_output="$TMPDIR/pi-bwrap-ssh-config-parse"
if ssh -G github.com > "$ssh_parse_output" 2>&1 && grep -q '^host github.com$' "$ssh_parse_output"; then
  pass 'ordinary OpenSSH client configuration parses inside the user namespace'
else
  fail 'ordinary OpenSSH client configuration parses inside the user namespace'
  if [ -r "$ssh_parse_output" ]; then cat "$ssh_parse_output"; fi
fi

if [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "$SSH_AUTH_SOCK" ]; then
  pass 'default SSH agent capability exposes an exact socket'
else
  fail 'default SSH agent capability exposes an exact socket; SSH_AUTH_SOCK must name an inherited socket'
fi

if touch "$PROJECT_PROBE" && rm -f "$PROJECT_PROBE"; then
  pass 'project root is writable'
else
  fail 'project root is writable'
fi

if bash -c 'touch "$1" && rm -f "$1"' _ "$CHILD_PROBE"; then
  pass 'child processes inherit project write access'
else
  fail 'child processes inherit project write access'
fi

if touch "$HOST_TMP_PROBE"; then
  fail 'host /tmp rejects writes outside private TMPDIR'
  rm -f "$HOST_TMP_PROBE"
else
  pass 'host /tmp rejects writes outside private TMPDIR'
fi

if touch "$GIT_PROBE"; then
  fail 'project .git is read-only by default'
  rm -f "$GIT_PROBE"
else
  pass 'project .git is read-only by default'
fi

private_key_visible=false
for private_key in id_ed25519 id_ecdsa id_ecdsa_sk id_rsa id_dsa; do
  if stat "$HOME/.ssh/$private_key"; then private_key_visible=true; fi
done
if [ "$private_key_visible" = false ]; then
  pass 'private SSH key files are hidden'
else
  fail 'private SSH key files are hidden'
fi

if [ -n "${SSH_AUTH_SOCK:-}" ]; then
  socket_directory=${SSH_AUTH_SOCK%/*}
  socket_name=${SSH_AUTH_SOCK##*/}
  case "$socket_directory" in
    "$HOME/.ssh/"*)
      unrelated=$(find "$socket_directory" -mindepth 1 -maxdepth 1 ! -name "$socket_name" -print -quit 2>&1)
      if [ -z "$unrelated" ]; then
        pass 'unrelated siblings beside the inherited SSH socket remain hidden'
      else
        fail "unrelated siblings beside the inherited SSH socket remain hidden: $unrelated"
      fi
      ;;
    *)
      printf 'SKIP: inherited SSH socket is not beneath the default denied ~/.ssh subtree\n'
      ;;
  esac
fi

if [ -e "$HOME/.ssh/config" ]; then
  if [ -r "$HOME/.ssh/config" ]; then
    pass 'explicit SSH config exception is readable'
  else
    fail 'explicit SSH config exception is readable'
  fi
else
  printf 'SKIP: SSH config does not exist on this host\n'
fi

remote_url=$(git remote get-url origin 2>&1) || remote_url=""
case "$remote_url" in
  git@*|ssh://*)
    transport_output="$TMPDIR/pi-bwrap-git-ssh-transport"
    if timeout 15 git ls-remote --exit-code origin HEAD > "$transport_output" 2>&1; then
      pass 'Git SSH transport authenticates through the inherited agent'
    else
      fail 'Git SSH transport authenticates through the inherited agent'
      if [ -r "$transport_output" ]; then
        printf '%s\n' '--- git ls-remote output ---'
        cat "$transport_output"
      fi
    fi
    ;;
  *)
    printf 'SKIP: origin is not an SSH remote; Git SSH transport was not exercised\n'
    ;;
esac

signing_ready=true
user_name=$(git config --global --get user.name 2>&1) || signing_ready=false
user_email=$(git config --global --get user.email 2>&1) || signing_ready=false
signing_key=$(git config --global --get user.signingkey 2>&1) || signing_ready=false
gpg_format=$(git config --global --get gpg.format 2>&1) || signing_ready=false
commit_signing=$(git config --global --type=bool --get commit.gpgsign 2>&1) || signing_ready=false

if [ "$signing_ready" = false ] || [ -z "$user_name" ] || [ -z "$user_email" ] || [ -z "$signing_key" ]; then
  fail 'global Git signing identity is complete (user.name, user.email, and user.signingkey)'
  printf 'Configured values: name=%q email=%q signingkey=%q\n' "$user_name" "$user_email" "$signing_key"
elif [ "$gpg_format" != "ssh" ] || [ "$commit_signing" != "true" ]; then
  fail 'global Git signing requires gpg.format=ssh and commit.gpgsign=true'
  printf 'Configured values: gpg.format=%q commit.gpgsign=%q\n' "$gpg_format" "$commit_signing"
elif [ -z "${SSH_AUTH_SOCK:-}" ] || [ ! -S "$SSH_AUTH_SOCK" ]; then
  fail 'real signed Git commit has an available SSH agent socket'
else
  pass 'global Git SSH signing configuration is inherited'
  SIGNING_REPO=$(mktemp -d "$TMPDIR/pi-bwrap-signing-XXXXXX")
  signing_output="$SIGNING_REPO/commit-output"
  if git -C "$SIGNING_REPO" init -q &&
    printf 'signed fixture\n' > "$SIGNING_REPO/fixture.txt" &&
    git -C "$SIGNING_REPO" add fixture.txt &&
    git -C "$SIGNING_REPO" commit -m 'sandbox signed fixture' > "$signing_output" 2>&1; then
    pass 'real Git commit succeeds without disabling global signing'
    if git -C "$SIGNING_REPO" cat-file commit HEAD | grep -q '^gpgsig -----BEGIN SSH SIGNATURE-----$'; then
      pass 'commit object contains an SSH gpgsig block'
    else
      fail 'commit object contains an SSH gpgsig block'
    fi

    public_key=""
    case "$signing_key" in
      key::*) public_key=${signing_key#key::} ;;
      ssh-*|ecdsa-*|sk-ssh-*|sk-ecdsa-*) public_key=$signing_key ;;
      "~/"*)
        key_path="$HOME/${signing_key#\~/}"
        if [ -r "$key_path" ]; then public_key=$(awk 'NR == 1 { print $1 " " $2; exit }' "$key_path"); fi
        ;;
      /*)
        if [ -r "$signing_key" ]; then public_key=$(awk 'NR == 1 { print $1 " " $2; exit }' "$signing_key"); fi
        ;;
    esac
    public_key=$(printf '%s\n' "$public_key" | awk 'NR == 1 { print $1 " " $2 }')
    case "$public_key" in
      ssh-*\ *|ecdsa-*\ *|sk-ssh-*\ *|sk-ecdsa-*\ *)
        allowed_signers="$SIGNING_REPO/allowed_signers"
        printf '%s %s\n' "$user_email" "$public_key" > "$allowed_signers"
        if git -C "$SIGNING_REPO" -c gpg.ssh.allowedSignersFile="$allowed_signers" verify-commit HEAD; then
          pass 'git verify-commit accepts the signed commit and temporary allowed signers file'
        else
          fail 'git verify-commit accepts the signed commit and temporary allowed signers file'
        fi
        ;;
      *)
        fail 'configured user.signingkey can produce a usable public SSH key for verification'
        printf 'Unsupported or unreadable user.signingkey form: %q\n' "$signing_key"
        ;;
    esac
  else
    fail 'real Git commit succeeds without disabling global signing'
    if [ -r "$signing_output" ]; then printf '%s\n' '--- git commit output ---'; cat "$signing_output"; fi
  fi
fi

if [ -n "$CLIPBOARD_FIXTURE" ]; then
  png_signature=$(od -An -N8 -tx1 "$CLIPBOARD_FIXTURE" | tr -d ' \n')
  if [ -r "$CLIPBOARD_FIXTURE" ] && [ "$png_signature" = "89504e470d0a1a0a" ]; then
    pass 'host-created clipboard PNG fixture is readable with a valid signature'
  else
    fail 'host-created clipboard PNG fixture is readable with a valid signature'
  fi
else
  fail 'host-created clipboard PNG fixture path was provided'
fi

if [ -r /etc/hostname ]; then
  pass 'unmatched host files remain readable'
else
  fail 'unmatched host files remain readable'
fi

printf '\nSUMMARY: %d passed, %d failed\n' "$passed" "$failed"
printf 'RESULT_LOG=%s\n' "$OUTPUT"

if [ "$failed" -ne 0 ]; then exit 1; fi
