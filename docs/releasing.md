# Release Conda Code

Conda Code publishes the same VSIX to the Visual Studio Marketplace and an
immutable GitHub Release through a tag-gated GitHub Actions workflow.

## Publish a release

1. Update `package.json` and `package-lock.json` to the new version.
2. Add the release to `CHANGELOG.md`.
3. Commit the release preparation and wait for the main checks and documentation
   workflows to pass.
4. Create and push a tag that exactly matches `package.json`:

   ```console
   RELEASE_VERSION=0.6.0
   git tag -s "${RELEASE_VERSION}" -m "Conda Code ${RELEASE_VERSION}"
   git push origin "${RELEASE_VERSION}"
   ```

The release workflow then:

1. checks that the tag and package version match
2. runs formatting, type checking, linting, and tests
3. builds and attests one versioned VSIX
4. creates a draft GitHub Release and uploads the VSIX
5. publishes that exact VSIX to the Visual Studio Marketplace
6. publishes the GitHub Release only after the Marketplace succeeds

Do not push a release tag until Marketplace publishing access has been verified.

If publishing is interrupted, use **Re-run failed jobs** in GitHub Actions. The
workflow reuses the uploaded VSIX and treats an already-published Marketplace
version as successful.

If draft creation itself is cancelled after the draft exists, inspect the
GitHub Release before rerunning the job. Remove only that incomplete draft, then
rerun the failed job. The workflow refuses to replace an existing release.
