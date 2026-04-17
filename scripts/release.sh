#!/usr/bin/env bash
# Bump coordonné package.json + server.json, puis rappelle les étapes suivantes.
# Usage: ./scripts/release.sh {patch|minor|major}
#
# Ce script ne commit rien et ne pousse rien : il se contente de bumper les 2
# fichiers et d'afficher les commandes à lancer ensuite (édition CHANGELOG,
# commit, tag, push). Le tag est ce qui déclenche la publication via CI.

set -euo pipefail

BUMP="${1:-}"
case "$BUMP" in
  patch|minor|major) ;;
  *)
    echo "Usage: $0 {patch|minor|major}" >&2
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -n "$(git status --porcelain package.json server.json)" ]; then
  echo "package.json ou server.json ont déjà des modifications non committées. Abort." >&2
  exit 1
fi

OLD_VERSION=$(node -p "require('./package.json').version")
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version | sed 's/^v//')

node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync('server.json', 'utf8'));
  s.version = process.env.NEW_VERSION;
  s.packages[0].version = process.env.NEW_VERSION;
  fs.writeFileSync('server.json', JSON.stringify(s, null, 2) + '\n');
" NEW_VERSION="$NEW_VERSION"

echo ""
echo "✓ Bumped $OLD_VERSION → $NEW_VERSION"
echo "  - package.json"
echo "  - server.json (top-level + packages[0])"
echo ""
echo "Next steps:"
echo "  1. Edit CHANGELOG.md — add a [$NEW_VERSION] — $(date +%Y-%m-%d) section"
echo "  2. git add package.json server.json CHANGELOG.md"
echo "  3. git commit -m \"v$NEW_VERSION: <summary>\""
echo "  4. git tag v$NEW_VERSION"
echo "  5. git push && git push --tags"
echo ""
echo "The tag push triggers .github/workflows/publish-mcp.yml, which publishes"
echo "to npm and the MCP Registry."
