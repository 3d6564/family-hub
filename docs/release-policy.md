# Release and rollback policy

Deployments run a published image from `compose.yaml`. The release workflow
builds that image. It does not deploy a host.

## Versions and images

- `package.json` is the application version source and uses
  `MAJOR.MINOR.PATCH`.
- Git tags and GitHub releases add `v`, such as `v0.2.0`.
- Images use immutable version tags, such as
  `ghcr.io/3d6564/family-hub:0.2.0`.
- `stable` points to the latest verified normal release. It is not a rollback
  reference.
- Drafts and prereleases do not move `stable` or appear in normal update
  checks.

Release images record these OCI labels:

- `org.opencontainers.image.version`: `package.json` version
- `org.opencontainers.image.revision`: full Git commit SHA
- `org.opencontainers.image.created`: UTC RFC 3339 build time

The release version is separate from the random deployment identifier used to
reload browsers after a server restart. Local builds must identify themselves
as development builds, not published releases.

## Publication order

1. Set the version and prepare release notes.
2. Run `npm run check` and `npm test`.
3. Build AMD64 and ARM64 images.
4. Push and verify the immutable version tag, manifest, metadata, and smoke
   tests.
5. Package the display installer, upload its assets to a draft GitHub release,
   download and verify those assets, then publish the release.
6. Move `stable` to the verified image digest.

Do not publish the release or move `stable` after a failed check.

`.github/workflows/release.yml` runs this order for a `v*` tag or a manual
run. Put the required notes in `docs/releases/<version>.md` before tagging.
The workflow checks that file, builds both architectures, smoke-tests the
image, and only then creates the version tag, GitHub release, and `stable`
tag. A prerelease does not move `stable`. The workflow does not deploy a host.

## Display installer assets

Each new release includes:

- `install-display.sh`: the tested standalone installer, with unchanged source
  bytes.
- `install-display.sh.sha256`: the SHA-256 and fixed installer filename.
- `display-installer.json`: schema version `1`, release tag, full tested commit,
  installer name/checksum, and checksum filename.

`scripts/package-display-release.js` creates these files without dependencies.
The release tag must match `package.json`. The workflow targets the tested
commit explicitly, uploads the files while the release is a draft, and compares
the downloaded files with the packaged bytes before publishing. A failed asset
check leaves the release unpublished and does not move `stable`.

Releases published before these assets were introduced do not support this
display installation method. Do not replace an existing release or fabricate
missing assets from a different commit.

Host tools can discover the latest stable release or select a fixed stable tag.
They must verify the installer checksum and retain the resolved release for
apply. A newly published release must not change an already previewed plan.
Publishing a display installer does not deploy either the display or the
application server. The installer's configuration-format version remains
separate from the release tag.

## Database rollback

Startup applies pending migrations before the container becomes healthy. Each
release must state one rollback classification for its named previous version:

- **Direct rollback supported:** The previous image can use the migrated
  database.
- **Backup restore required:** Restore the pre-update backup before deploying
  the previous image.
- **Rollback not supported:** Explain why and give upgrade instructions before
  publication.

Do not assume the classification applies when versions are skipped. Schema and
migration changes require approval. Never edit a released migration.

## Release notes

Each release includes:

```markdown
## Changes
## Setup changes
None.
## Database migrations
None.
## Rollback
Direct rollback supported to 0.1.0.
## Verification
- `npm run check`
- `npm test`
- AMD64 image smoke test
- ARM64 image smoke test
```

Replace `None` where needed. If restoration is required, link to the
[update and recovery guide](update-and-recovery.md).
