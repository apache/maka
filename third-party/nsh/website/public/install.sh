#!/usr/bin/env sh
# Installs a GitHub release, the nightly build of main with --nightly, or
# builds the latest main with --source.
#
#   curl -fsSL https://nsh.dev/install.sh | sh
#   curl -fsSL https://nsh.dev/install.sh | sh -s -- --nightly
#   curl -fsSL https://nsh.dev/install.sh | sh -s -- --source
#
# NSH_VERSION      a release tag such as v0.1.0, or nightly (default: the
#                  latest release)
# NSH_INSTALL_DIR  where the distribution goes (default: ~/.nsh); nsh finds
#                  its runtimes next to bin/nsh, so the directory stays whole
#
# `nsh` is linked into ~/.local/bin. Running the script again updates it.
set -eu

repository="longbridge/nsh"
dir="${NSH_INSTALL_DIR:-$HOME/.nsh}"
bin="$HOME/.local/bin"
version="${NSH_VERSION:-latest}"

fail() {
  echo "nsh: $*" >&2
  exit 1
}

source_install() {
  command -v git > /dev/null 2>&1 || fail "git is required for --source"
  command -v cargo > /dev/null 2>&1 || fail "Rust and Cargo are required for --source: https://rustup.rs"
  [ "$version" = latest ] || fail "--source builds the latest main; NSH_VERSION selects a release"
  case "$(uname -s)" in
    Darwin | Linux) ;;
    *) fail "--source supports macOS and Linux; see https://nsh.dev/docs/installation" ;;
  esac

  mkdir -p "$dir"
  dir="$(cd "$dir" && pwd -P)"
  source="$dir/source"
  if [ -e "$source" ]; then
    [ -e "$source/.git" ] || fail "$source is not an NSH checkout"
    changes="$(git -C "$source" status --porcelain)"
    [ -z "$changes" ] || fail "$source has local changes; keep them before updating"
    remote="$(git -C "$source" remote get-url origin)"
    [ "$remote" = "https://github.com/$repository.git" ] || fail "$source does not use the NSH repository"
    git -C "$source" fetch --depth 1 origin main
    git -C "$source" checkout --detach FETCH_HEAD
  else
    git clone --depth 1 --branch main "https://github.com/$repository.git" "$source"
  fi

  # Leave Cargo's directory and environment alone. The checkout stays so
  # the CLI can build development hosts and runtimes from the same revision.
  (cd "$source" && cargo build --release --locked -p nsh-cli)
  target="${CARGO_TARGET_DIR:-target}"
  case "$target" in
    /*) ;;
    *) target="$source/$target" ;;
  esac
  executable="$target/release/nsh"
  [ -x "$executable" ] || fail "no CLI at $executable; check your Cargo target directory settings"
  mkdir -p "$dir/bin" "$bin"
  ln -sf "$executable" "$dir/bin/nsh"
  ln -sf "$dir/bin/nsh" "$bin/nsh"
  echo "Installed $("$dir/bin/nsh" -V) from source to $dir"
}

case "$#:${1:-}" in
  0:) ;;
  1:--source)
    source_install
    case ":$PATH:" in
      *":$bin:"*) ;;
      *) echo "Add $bin to your PATH: export PATH=\"$bin:\$PATH\"" ;;
    esac
    exit 0
    ;;
  1:--nightly)
    [ "$version" = latest ] || fail "--nightly installs the nightly build; NSH_VERSION selects a release"
    version=nightly
    ;;
  1:--help)
    echo "Usage: install.sh [--nightly | --source]"
    echo "Install the latest release, the nightly build of main (--nightly), or build"
    echo "the latest main from source (--source, Git and Rust required)."
    exit 0
    ;;
  *) fail "usage: install.sh [--nightly | --source]" ;;
esac

machine="$(uname -m)"
# A shell under Rosetta reports x86_64 on Apple silicon: install the native build.
if [ "$(uname -s)" = Darwin ] && [ "$(sysctl -n sysctl.proc_translated 2> /dev/null)" = 1 ]; then
  machine=arm64
fi
case "$(uname -s)/$machine" in
  Darwin/arm64) platform="macos-arm64" ;;
  Darwin/x86_64) platform="macos-x86_64" ;;
  Linux/x86_64 | Linux/amd64) platform="linux-x86_64" ;;
  Linux/aarch64 | Linux/arm64) platform="linux-arm64" ;;
  *) fail "no prebuilt NSH for $(uname -s) $(uname -m); see https://nsh.dev/docs/installation" ;;
esac

command -v curl > /dev/null 2>&1 || fail "curl is required"

asset="nsh-$platform.tar.gz"
if [ "$version" = "latest" ]; then
  url="https://github.com/$repository/releases/latest/download/$asset"
else
  url="https://github.com/$repository/releases/download/$version/$asset"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

echo "Downloading $url"
curl -fsSL "$url" -o "$work/$asset"
curl -fsSL "$url.sha256" -o "$work/$asset.sha256"

(
  cd "$work"
  if command -v shasum > /dev/null 2>&1; then
    shasum -a 256 -c "$asset.sha256" > /dev/null
  else
    sha256sum -c "$asset.sha256" > /dev/null
  fi
) || fail "the checksum of $asset does not match"

tar -xzf "$work/$asset" -C "$work"
[ -x "$work/nsh/bin/nsh" ] || fail "$asset holds no nsh/bin/nsh"

# Replace the whole directory: runtimes of an older release must not stay.
mkdir -p "$(dirname "$dir")" "$bin"
rm -rf "$dir.old"
[ ! -e "$dir" ] || mv "$dir" "$dir.old"
mv "$work/nsh" "$dir"
rm -rf "$dir.old"
ln -sf "$dir/bin/nsh" "$bin/nsh"

echo "Installed $("$dir/bin/nsh" --version) to $dir"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Add $bin to your PATH: export PATH=\"$bin:\$PATH\"" ;;
esac
if [ "$(uname -s)" = Linux ]; then
  echo "The Linux runtime needs GTK 4.14 or newer (Ubuntu 24.04 and later)."
fi
