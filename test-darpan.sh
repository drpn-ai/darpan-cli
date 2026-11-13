#!/bin/sh
#
# Tests for bin/darpan. POSIX sh, no external test framework.
#
#   ./test-darpan.sh
#
# The script under test defines its functions and then dispatches on "$1", so
# sourcing it with no arguments prints help and leaves every function defined —
# that is how these tests reach the real implementations rather than copies.

set -u

CLI_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CLI="$CLI_DIR/bin/darpan"
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

# Run shell code with bin/darpan sourced. Values are passed through the
# environment, never as positional arguments: the script dispatches on "$1", so
# an argument here would run a subcommand instead of defining the functions.
with_cli() { CLI="$CLI" sh -c '. "$CLI" >/dev/null 2>&1
'"$1"; }

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
check() { # name expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi
}
contains() { # name haystack needle
  case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "expected to contain [$3], got [$2]" ;; esac
}

# A stand-in JDK whose `java -version` behaves like a real one, including the
# notice the JVM prints on stderr BEFORE the version when JAVA_TOOL_OPTIONS or
# _JAVA_OPTIONS is set — which is the whole point of the first two tests.
make_fake_jdk() { # $1=dir  $2=version string
  mkdir -p "$1/bin"
  cat > "$1/bin/java" <<EOF
#!/bin/sh
[ -n "\${JAVA_TOOL_OPTIONS:-}" ] && echo "Picked up JAVA_TOOL_OPTIONS: \$JAVA_TOOL_OPTIONS" >&2
[ -n "\${_JAVA_OPTIONS:-}" ] && echo "Picked up _JAVA_OPTIONS: \$_JAVA_OPTIONS" >&2
echo 'openjdk version "$2" 2024-07-16' >&2
echo 'OpenJDK Runtime Environment Temurin-$2+7 (build $2+7)' >&2
echo 'OpenJDK 64-Bit Server VM Temurin-$2+7 (build $2+7, mixed mode)' >&2
exit 0
EOF
  chmod +x "$1/bin/java"
}

echo "== JDK detection =="

FAKE21="$TMPROOT/jdk21"; make_fake_jdk "$FAKE21" "21.0.4"
FAKE17="$TMPROOT/jdk17"; make_fake_jdk "$FAKE17" "17.0.11"

out=$(JDK="$FAKE21" with_cli 'java_major_of "$JDK/bin/java"')
check "java_major_of reads the version with a clean environment" "21" "$out"

out=$(JDK="$FAKE21" JAVA_TOOL_OPTIONS="--add-opens=java.base/java.lang=ALL-UNNAMED" \
      with_cli 'java_major_of "$JDK/bin/java"')
check "java_major_of reads the version when JAVA_TOOL_OPTIONS is set" "21" "$out"

out=$(JDK="$FAKE21" _JAVA_OPTIONS="-Xmx1g" with_cli 'java_major_of "$JDK/bin/java"')
check "java_major_of reads the version when _JAVA_OPTIONS is set" "21" "$out"

if JAVA_TOOL_OPTIONS="-Dx=y" DARPAN_JAVA_HOME="$FAKE21" \
   with_cli 'resolve_jdk21' >/dev/null 2>&1
then ok "resolve_jdk21 accepts a JDK 21 while JAVA_TOOL_OPTIONS is exported"
else bad "resolve_jdk21 accepts a JDK 21 while JAVA_TOOL_OPTIONS is exported" "returned non-zero"
fi

# resolve_jdk21 deliberately falls through to other candidates when
# DARPAN_JAVA_HOME is wrong, so assert on the check itself rather than on
# whatever JDKs the host happens to have installed.
out=$(JDK="$FAKE17" with_cli 'java_major_of "$JDK/bin/java"')
check "java_major_of distinguishes a wrong major version" "17" "$out"

if JDK="$FAKE17" with_cli 'is_jdk_major "$JDK"' >/dev/null 2>&1
then bad "is_jdk_major rejects a JDK that is not 21" "accepted JDK 17"
else ok "is_jdk_major rejects a JDK that is not 21"
fi

if JDK="$FAKE21" JAVA_TOOL_OPTIONS="-Dx=y" with_cli 'is_jdk_major "$JDK"' >/dev/null 2>&1
then ok "is_jdk_major accepts JDK 21 with JAVA_TOOL_OPTIONS exported"
else bad "is_jdk_major accepts JDK 21 with JAVA_TOOL_OPTIONS exported" "rejected a real 21"
fi

echo "== sync_repo ref handling =="

ORIGIN="$TMPROOT/origin"
mkdir -p "$ORIGIN" && (
  cd "$ORIGIN" && git init -q -b main . &&
  git config user.email t@t && git config user.name t &&
  echo one > file && git add file && git commit -qm one && git tag v1 &&
  echo two > file && git commit -qam two
) >/dev/null 2>&1

run_sync() { # dest ref name -> prints "rc"
  DEST="$1" URL="$ORIGIN" REF="$2" NAME="$3" \
    with_cli 'sync_repo "$DEST" "$URL" "$REF" "$NAME"' >/dev/null 2>&1
  echo $?
}

rc=$(run_sync "$TMPROOT/good" v1 pkg)
check "sync_repo clones a valid ref" "0" "$rc"
head=$(git -C "$TMPROOT/good" show -s --format=%s 2>/dev/null || echo MISSING)
check "  and lands on that ref" "one" "$head"

rc=$(run_sync "$TMPROOT/bad" v1-typo pkg)
if [ "$rc" != "0" ]; then ok "sync_repo fails on a ref that does not exist"
else bad "sync_repo fails on a ref that does not exist" "returned 0"; fi
if [ -d "$TMPROOT/bad/.git" ]; then
  landed=$(git -C "$TMPROOT/bad" show -s --format=%s 2>/dev/null || echo "")
  bad "  and does not silently clone the default branch" "left a clone at [$landed]"
else
  ok "  and does not silently clone the default branch"
fi

rc=$(run_sync "$TMPROOT/good" v1-typo pkg)
if [ "$rc" != "0" ]; then ok "sync_repo fails when UPDATING to a ref that does not exist"
else bad "sync_repo fails when UPDATING to a ref that does not exist" "returned 0"; fi

echo "== doctor =="

out=$(PATH=/nonexistent DARPAN_SKIP_JDK_CHECK=1 /bin/sh "$CLI" doctor 2>&1 || true)
contains "doctor counts every failed check, not just the last" "$out" "4 check(s) failed"

echo "== up: load guard =="

PORT=57391
python3 -c "
import socket, time, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', $PORT)); s.listen(1)
sys.stderr.write('listening\n'); sys.stderr.flush()
time.sleep(30)
" 2>/dev/null &
LISTENER=$!
sleep 1

WS="$TMPROOT/ws"
out=$(DARPAN_BACKEND_PORT=$PORT DARPAN_SKIP_JDK_CHECK=1 \
      /bin/sh "$CLI" up --dir "$WS" 2>&1 || true)
contains "up refuses to load while a backend holds the port" "$out" "loads need the DB unlocked"
if [ -d "$WS/darpan-backend/.git" ]; then
  bad "  and refuses before cloning anything" "cloned darpan-backend anyway"
else
  ok "  and refuses before cloning anything"
fi
kill $LISTENER 2>/dev/null || true
wait $LISTENER 2>/dev/null || true

echo "== one command: data and actions go to Node (DAR-CLI-003) =="

CFG="$TMPROOT/emptycfg"; mkdir -p "$CFG"
out=$(DARPAN_CONFIG_DIR="$CFG" /bin/sh "$CLI" whoami 2>&1); rc=$?
check "darpan whoami with no sign-in exits 3 (via Node)" "3" "$rc"
contains "  and says to run darpan login" "$out" "darpan login"

out=$(/bin/sh "$CLI" guide 2>&1); rc=$?
check "darpan guide exits 0" "0" "$rc"
contains "  and prints the guide" "$out" "Usual path: whoami"

# Homebrew links bin/darpan into its prefix: the launcher must find ../agent through the link.
LINKDIR="$TMPROOT/linkbin"; mkdir -p "$LINKDIR"; ln -s "$CLI" "$LINKDIR/darpan"; ln -s "$LINKDIR/darpan" "$LINKDIR/darpan2"
out=$(/bin/sh "$LINKDIR/darpan2" guide 2>&1); rc=$?
check "a symlink to a symlink still reaches the agent" "0" "$rc"
contains "  and runs it" "$out" "Usual path: whoami"

# ...and through a symlinked directory (macOS /var -> /private/var, Homebrew's opt/ links): node sees a different path than argv.
ln -s "$CLI_DIR" "$TMPROOT/clidirlink"
out=$(/bin/sh "$TMPROOT/clidirlink/bin/darpan" guide 2>&1); rc=$?
contains "a symlinked install directory still prints output" "$out" "Usual path: whoami"

out=$(/bin/sh "$CLI" help 2>&1)
contains "help lists the data and action group" "$out" "darpan guide"
case "$out" in *DARPAN_GQL_KEY*) bad "help no longer mentions DARPAN_GQL_KEY" "found" ;; *) ok "help no longer mentions DARPAN_GQL_KEY" ;; esac

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
