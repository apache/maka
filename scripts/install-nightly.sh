#!/usr/bin/env sh
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

# Installs the unofficial Apache Maka (incubating) Nightly developer build
# on Linux (x64 / arm64) or macOS (arm64).
# NOT an official Apache Software Foundation release — for developer testing only.

set -eu

REPO="${MAKA_REPO:-apache/maka}"
TAG="${MAKA_TAG:-nightly}"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}:${ARCH}" in
  Linux:x86_64)
    ASSET="Maka-nightly-linux-x64.tar.gz"
    KIND="linux"
    ;;
  Linux:aarch64 | Linux:arm64)
    ASSET="Maka-nightly-linux-arm64.tar.gz"
    KIND="linux"
    ;;
  Darwin:arm64)
    ASSET="Maka-nightly-macos-arm64.tar.gz"
    KIND="macos"
    ;;
  *)
    echo "Unsupported platform: ${OS} ${ARCH}" >&2
    exit 1
    ;;
esac

echo "Installing Apache Maka (incubating) Nightly (${ASSET})..."
echo "NOTE: Unofficial developer nightly build — NOT an Apache Software Foundation release."

TMPDIR_WORK="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_WORK}"' EXIT INT TERM

curl -fsSL "${BASE_URL}/${ASSET}" -o "${TMPDIR_WORK}/${ASSET}"
curl -fsSL "${BASE_URL}/SHA256SUMS.txt" -o "${TMPDIR_WORK}/SHA256SUMS.txt"

EXPECTED="$(awk -v name="${ASSET}" '$2 == name { print $1; exit }' "${TMPDIR_WORK}/SHA256SUMS.txt")"
if [ -z "${EXPECTED}" ]; then
  echo "Failed to find checksum for ${ASSET} in SHA256SUMS.txt" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "${TMPDIR_WORK}/${ASSET}" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "${TMPDIR_WORK}/${ASSET}" | awk '{ print $1 }')"
else
  echo "Neither sha256sum nor shasum found to verify download" >&2
  exit 1
fi

if [ "${ACTUAL}" != "${EXPECTED}" ]; then
  echo "SHA-256 mismatch for ${ASSET}: expected ${EXPECTED}, got ${ACTUAL}" >&2
  exit 1
fi

tar -xzf "${TMPDIR_WORK}/${ASSET}" -C "${TMPDIR_WORK}"

if [ "${KIND}" = "linux" ]; then
  INSTALL_DIR="${MAKA_INSTALL_DIR:-${HOME}/.local/share/maka}"
  BIN_DIR="${HOME}/.local/bin"
  APP_DIR="${HOME}/.local/share/applications"
  ICON_DIR="${HOME}/.local/share/icons/hicolor/256x256/apps"

  mkdir -p "$(dirname "${INSTALL_DIR}")" "${BIN_DIR}" "${APP_DIR}" "${ICON_DIR}"
  rm -rf "${INSTALL_DIR}.new"
  mv "${TMPDIR_WORK}/maka" "${INSTALL_DIR}.new"
  rm -rf "${INSTALL_DIR}"
  mv "${INSTALL_DIR}.new" "${INSTALL_DIR}"

  ln -sf "${INSTALL_DIR}/maka" "${BIN_DIR}/maka"
  if [ -f "${INSTALL_DIR}/maka.png" ]; then
    cp "${INSTALL_DIR}/maka.png" "${ICON_DIR}/org.apache.maka.desktop.png"
  fi

  cat > "${APP_DIR}/org.apache.maka.desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Maka
Comment=Apache Maka (incubating) Nightly developer build
Exec=${INSTALL_DIR}/maka-desktop-shell
Icon=org.apache.maka.desktop
Terminal=false
Categories=Development;Utility;
StartupWMClass=org.apache.maka.desktop
EOF

  echo "Installed Maka to ${INSTALL_DIR}"
  echo "CLI symlink: ${BIN_DIR}/maka"
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *) echo "Add ${BIN_DIR} to your PATH to run 'maka' from any shell." ;;
  esac
else
  DEST_APP="${MAKA_APP_PATH:-/Applications/Maka.app}"
  BIN_DIR="${HOME}/.local/bin"
  if [ ! -w "$(dirname "${DEST_APP}")" ]; then
    DEST_APP="${HOME}/Applications/Maka.app"
  fi
  mkdir -p "$(dirname "${DEST_APP}")" "${BIN_DIR}"
  rm -rf "${DEST_APP}.new"
  mv "${TMPDIR_WORK}/Maka.app" "${DEST_APP}.new"
  rm -rf "${DEST_APP}"
  mv "${DEST_APP}.new" "${DEST_APP}"
  ln -sf "${DEST_APP}/Contents/MacOS/maka" "${BIN_DIR}/maka"

  echo "Installed Maka to ${DEST_APP}"
  echo "CLI symlink: ${BIN_DIR}/maka"
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *) echo "Add ${BIN_DIR} to your PATH to run 'maka' from any shell." ;;
  esac
fi
