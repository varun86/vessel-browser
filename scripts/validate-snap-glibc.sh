#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <snap-file-or-unpacked-dir> [core20|core22|core24]" >&2
  exit 2
fi

target="$1"
base="${2:-core22}"

case "$base" in
  core20) max_glibc="2.31" ;;
  core22) max_glibc="2.35" ;;
  core24) max_glibc="2.39" ;;
  *)
    echo "Unsupported snap base '$base'." >&2
    exit 2
    ;;
esac

for tool in file strings sort; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing required tool: $tool" >&2
    exit 2
  fi
done

tmp_dir=""
violations_file=""
cleanup() {
  if [ -n "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
  if [ -n "$violations_file" ]; then
    rm -f "$violations_file"
  fi
}
trap cleanup EXIT

if [ -f "$target" ]; then
  if ! command -v unsquashfs >/dev/null 2>&1; then
    echo "Missing required tool: unsquashfs" >&2
    exit 2
  fi
  tmp_dir="$(mktemp -d)"
  root="$tmp_dir/squashfs-root"
  unsquashfs -q -d "$root" "$target"
elif [ -d "$target" ]; then
  root="$target"
else
  echo "Target does not exist: $target" >&2
  exit 2
fi

version_gt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]
}

violations_file="$(mktemp)"
while IFS= read -r -d '' candidate; do
  if ! file -b "$candidate" | grep -q 'ELF'; then
    continue
  fi

  while IFS= read -r required; do
    if version_gt "$required" "$max_glibc"; then
      printf 'GLIBC_%s %s\n' "$required" "${candidate#"$root"/}" >> "$violations_file"
    fi
  done < <(strings "$candidate" | grep -aoE 'GLIBC_[0-9]+\.[0-9]+' | sed 's/^GLIBC_//' | sort -Vu)
done < <(find "$root" -type f -print0)

if [ -s "$violations_file" ]; then
  echo "Snap contains binaries that require newer glibc symbols than $base supports (max GLIBC_$max_glibc):" >&2
  sort -Vu "$violations_file" >&2
  exit 1
fi

echo "Snap GLIBC requirements are compatible with $base (max GLIBC_$max_glibc)."
