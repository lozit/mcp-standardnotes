# Release runbook

End-to-end checklist for publishing a new version of `mcp-standardnotes`
to **npm** and the **MCP Registry**.

The CI workflow `.github/workflows/publish-mcp.yml` does the actual publish
when a tag `v*` is pushed. Everything below is the manual prep + the trigger.

---

## 0. Decide the version bump

Semver:
- **patch** (`0.3.1 → 0.3.2`): bugfix, no API change.
- **minor** (`0.3.x → 0.4.0`): new MCP tool, new env var, behavior change that's backward-compatible.
- **major** (`0.x.y → 1.0.0`): breaking change.

Used below as `NEW_VERSION`.

---

## 1. Pre-release checks

Run from a clean `main`:

```bash
git checkout main
git pull --ff-only
git status                 # must be clean
gh run list --branch main --limit 1   # last CI run must be ✅
```

If the last CI on `main` is red, fix it first — `publish-mcp.yml` doesn't
gate on CI, so a broken `main` can still be tagged and would publish broken
code to npm.

---

## 2. Bump versions in three places

The publish workflow refuses to publish if these don't all match the tag:

1. `package.json` → `"version": "NEW_VERSION"`
2. `server.json` → root `"version": "NEW_VERSION"`
3. `server.json` → `"packages"[0]."version": "NEW_VERSION"`

Quick sanity check:

```bash
node -e 'const p=require("./package.json"), s=require("./server.json"); console.log({pkg:p.version, srvRoot:s.version, srvPkg:s.packages[0].version})'
```

All three must equal `NEW_VERSION`.

---

## 3. CHANGELOG entry

Add a new section at the top of `CHANGELOG.md`, mirroring the existing
"Keep a Changelog" format:

```markdown
## [NEW_VERSION] — YYYY-MM-DD

### Added | Changed | Fixed | Security
- One bullet per user-visible change. Focus on the "why".
```

Use `Fixed` for bugfix releases, `Security` for vuln fixes, `Added/Changed`
for features.

---

## 4. Local verification

These must all pass before tagging. The CI runs the same commands:

```bash
npm ci                        # ensures lockfile is healthy
npm run typecheck
npm run lint
npm test
npm run build
npm audit --audit-level=high  # blocker if anything HIGH/CRITICAL is left
```

Pitfalls:
- **`engines.node`**: keep `>=20`. `undici@8` requires Node `>=22.19` and
  breaks Node 20 CI — pin `undici` to `^7.x`. (See
  `memory/project_sn_cloudflare_h2.md` for context.)
- **Transitive vulns**: if `npm audit` flags HIGH severity in a transitive
  dep we don't directly control (e.g. through MCP SDK), use `overrides`
  in `package.json` rather than waiting for upstream.

---

## 5. Commit

```bash
git add package.json server.json CHANGELOG.md package-lock.json
git commit -m "chore(release): vNEW_VERSION"
```

Don't include unrelated changes — release commits should only bump versions
and update the changelog. Squash any tag-prep cleanup into one commit.

---

## 6. Tag and push (triggers publication)

```bash
git tag vNEW_VERSION
git push origin main --follow-tags
```

`--follow-tags` pushes the commit AND any annotated tags reachable from
the new HEAD in a single step. The tag push is what fires
`publish-mcp.yml`.

**This step is irreversible** — once the workflow publishes to npm, you
can only deprecate/unpublish within 72h and only under strict npm rules.
Double-check version numbers before pushing the tag.

---

## 7. Watch the publish workflow

```bash
gh run watch                  # follow the latest run
# or
gh run list --workflow=publish-mcp.yml --limit 1
```

The workflow:
1. Verifies the three versions match `$GITHUB_REF_NAME` (the tag).
2. Re-runs typecheck/lint/test/build.
3. `npm publish --provenance --access public` (signed via OIDC, no token leak).
4. Authenticates to MCP Registry via `mcp-publisher login github-oidc`.
5. Validates `server.json` against the registry schema.
6. Publishes to the MCP Registry.

If any step fails, **the tag stays in place** — fix the issue on `main`,
delete the bad tag (`git tag -d vX.Y.Z && git push --delete origin vX.Y.Z`),
retag, and push again.

---

## 8. Post-release verification

```bash
npm view mcp-standardnotes version                      # should show NEW_VERSION
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=mcp-standardnotes" | jq '.[0].version'
```

The MCP Registry may take a couple of minutes to reflect the new version.

---

## Quick reference

```bash
# From a clean main, for a patch bump 0.3.1 → 0.3.2:
NEW_VERSION=0.3.2

# 1-2-3: bump files (manual edit, or jq/sed if scripting)
# 4: verify
npm ci && npm run typecheck && npm run lint && npm test && npm run build && npm audit --audit-level=high

# 5: commit
git add package.json server.json CHANGELOG.md package-lock.json
git commit -m "chore(release): v${NEW_VERSION}"

# 6: tag + push (triggers CI publish)
git tag "v${NEW_VERSION}"
git push origin main --follow-tags

# 7: watch
gh run watch
```
