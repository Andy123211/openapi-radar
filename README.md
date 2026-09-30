# OpenAPI Radar

OpenAPI Radar is a GitHub Action that compares the OpenAPI document at the exact base and head commits of a pull request. It reports breaking changes in the Actions job summary and maintains one bot-authored pull request comment with migration guidance.

## Features

- Reads the base and head documents through the GitHub API; no checkout step is required.
- Uses the fixed **openapi-changes 0.2.11** release and verifies the platform archive against a pinned SHA-256 digest before execution.
- Updates its existing report comment on later runs instead of adding a new comment each time.
- Writes the report to the Actions job summary even when a fork pull request receives a read-only token.
- Fails the check on breaking changes by default.

## Quick start

Add this workflow to **.github/workflows/openapi-radar.yml**:

~~~yaml
name: OpenAPI compatibility

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  openapi:
    runs-on: ubuntu-latest
    steps:
      - name: Check API compatibility
        uses: Andy123211/openapi-radar@v1
        with:
          token: ${{ github.token }}
          base-spec-file: api/openapi.yaml
          head-spec-file: api/openapi.yaml
          fail-on-breaking: true
~~~

The action fetches each file at the pull request base and head commit. It does not check out or execute pull request code. Set **base-spec-file** and **head-spec-file** separately if a pull request moves the spec.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| **token** | Required | A repository token with **contents: read**; **pull-requests: write** is needed to create or update the report comment. |
| **base-spec-file** | **openapi.yaml** | Repository-relative OpenAPI path at the base commit. |
| **head-spec-file** | **openapi.yaml** | Repository-relative OpenAPI path at the head commit. |
| **update-comment** | **true** | Create or update OpenAPI Radar's bot comment. Set to **false** to report only in the job summary. |
| **fail-on-breaking** | **true** | Fail the Action after it writes the report when breaking changes are found. |

Both spec files must be at most 5 MiB. The action accepts repository-relative paths with forward slashes. It supports pull request workflows using the **pull_request** event.

## Outputs

| Output | Description |
| --- | --- |
| **total-changes** | Number of changes reported by **openapi-changes**. |
| **breaking-changes** | Number of breaking changes. |

## Fork pull requests

GitHub gives workflows triggered by fork pull requests a read-only **GITHUB_TOKEN**. OpenAPI Radar still reads the public base/head specs and writes the report to the job summary, but GitHub may reject the comment update. The Action emits a warning and continues with the configured breaking-change result. Keep the workflow on **pull_request**; do not switch to **pull_request_target** to enable comments for forks.

## Security and runtime

- Grant only **contents: read** and, when comments are enabled, **pull-requests: write**.
- The token is used by the action process for GitHub API requests and is removed from the environment passed to npm and the OpenAPI parser.
- Runtime setup installs the pinned npm wrapper with lifecycle scripts disabled. It then downloads the matching **openapi-changes 0.2.11** release archive and checks its SHA-256 against the digest embedded in the source before extracting or running the Go executable.
- The runner needs Node.js 24, npm, and outbound HTTPS access to **api.github.com**, **registry.npmjs.org**, and **github.com**. Supported release binaries cover Linux, macOS, and Windows on x64, ARM64, and 32-bit x86 where published.
- The Action reads untrusted OpenAPI documents but does not execute their contents. Review breaking-change reports and generated migration hints before merging; the hints are general suggestions, not a substitute for client impact analysis.

## Limitations

- One base/head document pair is compared per Action run.
- Private fork documents must be readable by the supplied token. Public fork documents can be read without granting the fork write access.
- The action requires network access at runtime to install the pinned parser package and fetch its verified release binary.
- The parser and breaking-change classification are provided by **openapi-changes 0.2.11**.

## Development

~~~sh
npm ci --ignore-scripts
npm run typecheck
npm run build
~~~

Commit the generated **dist/index.js** with source changes so GitHub can execute the Action without installing this repository's development dependencies.

## License

MIT
