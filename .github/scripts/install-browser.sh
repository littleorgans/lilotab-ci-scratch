#!/usr/bin/env bash
# Puts one browser of the browser matrix on a GitHub hosted Ubuntu or Windows runner through its vendor's channel and
# writes `exe` (empty for the harness's pinned Chrome for Testing) and `version` to $GITHUB_OUTPUT, or `skip` with the
# reason when the browser cannot run here. Runs from the repository root after `just install`.
# Usage: install-browser.sh <cft-pinned|cft-148|chrome|edge|brave|opera>
set -uo pipefail
browser=$1
out=${GITHUB_OUTPUT:-/dev/stdout}
if [[ $RUNNER_OS == Windows ]]; then
  programs=$(cygpath -u "$PROGRAMFILES")
  local_data=$(cygpath -u "$LOCALAPPDATA")
fi

skip() {
  echo "skip=$*" >>"$out"
  echo "::warning title=$browser skipped::$*"
  exit 0
}

# The newest existing file among the candidates; globs that match nothing stay literal and fail the -f test.
first() {
  local found
  found=$(for f in "$@"; do [[ -f $f ]] && echo "$f"; done | sort -V | tail -n 1)
  [[ -n $found ]] && echo "$found"
}

# <name> <key url> <repository after the options> <package>...: the vendor's signed apt repository, then its packages.
apt_vendor() {
  local keyring=/usr/share/keyrings/$1.gpg key
  key=$(mktemp)
  curl -fsSL "$2" -o "$key" || return 1
  if grep -q 'BEGIN PGP' "$key"; then
    sudo gpg --dearmor --yes -o "$keyring" "$key" || return 1
  else
    sudo install -m 644 "$key" "$keyring" || return 1
  fi
  echo "deb [arch=amd64 signed-by=$keyring] $3" | sudo tee "/etc/apt/sources.list.d/$1.list" >/dev/null &&
    sudo apt-get update -qq &&
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${@:4}"
}

choco_vendor() {
  choco install "$1" -y --no-progress --limit-output
}

cft() {
  ./node_modules/.bin/browsers install "chrome@$1" --path "$PWD/.smoke/browsers" --format '{{path}}' | tail -n 1
}

case "$RUNNER_OS-$browser" in
  *-cft-pinned) exe='' ;;
  *-cft-148) exe=$(cft 148) || skip 'Chrome for Testing 148 download failed' ;;
  Linux-chrome) exe=$(first /usr/bin/google-chrome) ;;
  Linux-edge) exe=$(first /usr/bin/microsoft-edge-stable /usr/bin/microsoft-edge) ;;
  Linux-brave)
    apt_vendor brave https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
      'https://brave-browser-apt-release.s3.brave.com/ stable main' brave-browser || skip 'Brave apt install failed'
    exe=$(first /usr/bin/brave-browser)
    ;;
  Linux-opera)
    # Opera reads the GNOME desktop background setting at startup, and GLib aborts it with SIGTRAP when that schema is
    # missing, as on the runner image; installing opera-stable does not pull them in.
    apt_vendor opera https://deb.opera.com/archive.key 'https://deb.opera.com/opera-stable/ stable non-free' \
      opera-stable gsettings-desktop-schemas || skip 'Opera apt install failed'
    exe=$(first /usr/bin/opera)
    ;;
  Windows-chrome) exe=$(first "$programs/Google/Chrome/Application/chrome.exe") ;;
  Windows-edge) exe=$(first "$programs (x86)/Microsoft/Edge/Application/msedge.exe" "$programs/Microsoft/Edge/Application/msedge.exe") ;;
  Windows-brave)
    choco_vendor brave || skip 'Brave choco install failed'
    exe=$(first "$programs/BraveSoftware/Brave-Browser/Application/brave.exe" "$local_data/BraveSoftware/Brave-Browser/Application/brave.exe")
    ;;
  Windows-opera)
    # Opera keeps its browser binary in a version folder beside a top level launcher; Puppeteer must start the browser.
    choco_vendor opera || skip 'Opera choco install failed'
    exe=$(first "$programs"/Opera/*/opera.exe "$local_data"/Programs/Opera/*/opera.exe)
    ;;
  *) skip "no install route for $browser on $RUNNER_OS" ;;
esac

if [[ $browser != cft-pinned ]]; then
  [[ -n $exe ]] || skip "$browser executable not found after install"
  if [[ $RUNNER_OS == Windows ]]; then
    exe=$(cygpath -m "$exe")
    version=$(powershell -NoProfile -Command "(Get-Item -LiteralPath '$exe').VersionInfo.ProductVersion")
  else
    version=$(timeout 30 "$exe" --version)
  fi
fi
{
  echo "exe=$exe"
  echo "version=${version:-}"
} >>"$out"
