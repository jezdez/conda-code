# Release Conda Code

Conda Code publishes the same VSIX to the Visual Studio Marketplace and an
immutable GitHub Release. GitHub Actions authenticates to the Marketplace with
GitHub OIDC and a Microsoft Entra application. It does not store a Personal
Access Token or client secret.

## Configure the publishing identity

This setup is required once.

1. In the Microsoft Entra admin center, create an app registration named
   `conda-code-github-publisher`. Do not create a client secret. Record its
   **Application (client) ID** and **Directory (tenant) ID**.
2. Open **Certificates & secrets**, then **Federated credentials**, and add a
   credential for **GitHub Actions deploying Azure resources** with these
   values:

   | Field           | Value                |
   | --------------- | -------------------- |
   | Organization    | `jezdez`             |
   | Organization ID | `1610`               |
   | Repository      | `conda-code`         |
   | Repository ID   | `1311183246`         |
   | Entity type     | `Environment`        |
   | Environment     | `vscode-marketplace` |

   The resulting subject must be
   `repo:jezdez@1610/conda-code@1311183246:environment:vscode-marketplace`.

3. Add the two non-secret IDs to the `vscode-marketplace` GitHub environment.
   The environment is restricted to `main` and `*.*.*` tags:

   ```console
   gh variable set AZURE_CLIENT_ID --env vscode-marketplace --body APPLICATION_ID
   gh variable set AZURE_TENANT_ID --env vscode-marketplace --body TENANT_ID
   ```

   See Microsoft's
   [GitHub federation documentation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust#github-actions)
   for the Entra configuration.

4. Run the **Marketplace identity** workflow from `main`. Its job summary shows
   the application's Azure DevOps profile ID:

   ```console
   gh workflow run marketplace-identity.yml --ref main
   ```

5. Open the
   [Visual Studio Marketplace publisher portal](https://marketplace.visualstudio.com/manage/publishers/jezdez),
   select **Members**, add that profile ID, and assign the **Contributor** role.

The application needs no Azure subscription or Azure role. The release workflow
uses `allow-no-subscriptions` and requests a short-lived Azure DevOps token
through the Azure CLI credential established by `azure/login`.

## Publish a release

1. Update `package.json` and `package-lock.json` to the new version.
2. Add the release to `CHANGELOG.md`.
3. Commit the release preparation and wait for the main checks and documentation
   workflows to pass.
4. Create and push a tag that exactly matches `package.json`:

   ```console
   git tag -s 0.1.0 -m "Conda Code 0.1.0"
   git push origin 0.1.0
   ```

The release workflow then:

1. checks that the tag and package version match
2. runs formatting, type checking, linting, and tests
3. builds and attests one versioned VSIX
4. creates a draft GitHub Release and uploads the VSIX
5. publishes that exact VSIX to the Visual Studio Marketplace
6. publishes the GitHub Release only after the Marketplace succeeds

Do not push a release tag until the publishing identity appears as a Contributor
on the `jezdez` publisher.

If publishing is interrupted, use **Re-run failed jobs** in GitHub Actions. The
workflow reuses the uploaded VSIX and treats an already-published Marketplace
version as successful.
