#!/usr/bin/env bash
# Populate the platform npm packages from arterm release tarballs.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <release-assets-directory>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
assets="$(cd "$1" && pwd)"

prepare() {
  local package="$1" archive="$2" archived_binary="$3" installed_binary="$4"
  local package_dir="$repo_root/sdk/npm/$package"
  rm -rf "$package_dir/bin"
  mkdir -p "$package_dir/bin"
  tar -xzf "$assets/$archive" -C "$package_dir/bin"
  mv "$package_dir/bin/$archived_binary" "$package_dir/bin/$installed_binary"
  chmod +x "$package_dir/bin/$installed_binary"
}

prepare linux-x64 arterm-linux-x86_64.tar.gz arterm-linux-x86_64 arterm
prepare linux-arm64 arterm-linux-aarch64.tar.gz arterm-linux-aarch64 arterm
prepare darwin-x64 arterm-macos-x86_64.tar.gz arterm-macos-x86_64 arterm
prepare darwin-arm64 arterm-macos-aarch64.tar.gz arterm-macos-aarch64 arterm
prepare win32-x64 arterm-windows-x86_64.tar.gz arterm-windows-x86_64.exe arterm.exe
prepare win32-arm64 arterm-windows-aarch64.tar.gz arterm-windows-aarch64.exe arterm.exe
