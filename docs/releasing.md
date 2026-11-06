# Release Conda Code

Conda Code publishes the same VSIX to the Visual Studio Marketplace and an
immutable GitHub Release through a tag-gated GitHub Actions workflow.

## Publish a release

1. Update `package.json` and `package-lock.json` to the new version.
2. Add the exact heading `## 0.9.0` to `CHANGELOG.md` for this release. The workflow
   extracts that section as the release notes.
3. Run `npm run test:coverage`, `npm run lint`, `npm run typecheck`,
   `npm run format:check`, `npm run docs`, and `npm run vsix`.
4. Run the isolated VS Code smoke test described in the repository README. Record
   the tested commit, OS, VS Code version, and Python extension versions in the
   release preparation PR. CI's unit tests do not exercise the extension host.
5. Commit the release preparation and wait for the main checks and documentation
   workflows to pass.
6. Verify Marketplace publishing access, then create and push a tag that exactly
   matches `package.json`:

   ```console
   RELEASE_VERSION=0.9.0
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
