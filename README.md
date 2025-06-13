# Build Stainless SDKs from GitHub Actions

GitHub Actions for building [Stainless](https://stainless.com/) SDKs and
previewing changes to an SDK from a pull request.

## Usage

Get an API key from your Stainless organization dashboard, and add it to your
[repository secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions#creating-secrets-for-a-repository)
with the name `STAINLESS_API_KEY`. You can do this with the GitHub CLI via:

```
gh secret set STAINLESS_API_KEY
```

Copy the [example workflow](./examples/pull_request.yml) to your repository's
`.github/workflows` directory, and replace the `env` variables as needed.

Pull requests to your GitHub repository that update OpenAPI spec or Stainless
config will build your SDKs and make a comment with the results.

For more examples of usage, including push-based workflows, using code samples,
and integration with docs platforms, see the [examples directory](./examples).

## Actions

This repository provides three GitHub actions.

- `stainless-api/build-sdk-action`: Build SDKs for a Stainless project. For
information about the input parameters, see the [action definition](./action.yml).

- `stainless-api/build-sdk-action/preview`: Preview changes to SDKs introduced
by a pull request. For information about the input parameters, see the
[action definition](./preview/action.yml).

- `stainless-api/build-sdk-action/merge`: Merge changes to SDKs from a pull
request. For information about the input parameters, see the
[action definition](./merge/action.yml).

### Workflow permissions

The GitHub actions use the following
[workflow permissions](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#jobsjob_idpermissions):

- The `preview` and `merge` actions have a `make_comment` input, which, if set,
will comment on the pull request with the build results. This is set to true by
default. The actions use the `github_token` input to make a comment, and the
comment must have the `pull-requests: write` permission.

- The `preview` action relies on being in a Git repository that can fetch from
the remote to determine base revisions. This will be the case if you use the
[`actions/checkout`](https://github.com/actions/checkout) GitHub action
beforehand. That action needs the `contents: read` permission.

### Versioning policy

This action is in public beta, and breaking changes may be introduced in any
commit. We recommend pinning your actions to a full-length commit SHA to avoid
potential breaking changes.
