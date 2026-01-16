#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REFS_DIR="$ROOT_DIR/refs"

clone_or_update() {
  local name="$1"
  local url="$2"
  local dir="$REFS_DIR/$name"

  mkdir -p "$REFS_DIR"

  if [[ -d "$dir/.git" || -f "$dir/.git" ]]; then
    echo "Updating $name..."
    git -C "$dir" fetch --all --prune
    echo "  Current: $(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo '?')"
    echo "  Tip: to move branches, run: git -C \"$dir\" pull --rebase"
    return 0
  fi

  if [[ -e "$dir" ]]; then
    echo "Skipping $name: $dir exists but is not a git repo."
    return 0
  fi

  echo "Cloning $name..."
  git clone --depth 1 "$url" "$dir"
}

clone_or_update "codex" "https://github.com/openai/codex.git"
clone_or_update "claude-agent-sdk-typescript" "https://github.com/anthropics/claude-agent-sdk-typescript.git"

echo "Done."
