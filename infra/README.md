# infra/ — GitHub settings managed with Alchemy v2

This directory holds the Alchemy v2 program (`alchemy.run.ts`) that
declaratively manages the baseline GitHub settings of a repository
created from this template.

## What it manages

- **Repository settings**: default branch `main`, and
  `delete_branch_on_merge` enabled (head branches are deleted after a
  merge). Merge / squash / rebase strategies are left at GitHub
  defaults on purpose.
- **One branch ruleset** named `baseline-protection` on the default
  branch. It is deliberately *not* strict — it only:
  - blocks branch deletion (`deletion` rule)
  - blocks force pushes (`non_fast_forward` rule)

  No required reviews, no required status checks, no bypass actors.
  Tighten it per-repository when a repo actually needs more.

## How it works

Alchemy v2 (`alchemy@2.0.0-beta.84`) has no built-in GitHub repository
or ruleset resource, so the program declares an Alchemy Stack with the
local state store and runs an idempotent converge against the GitHub
REST API inside the stack body: read current state, diff against the
desired state declared at the top of `alchemy.run.ts`, write only what
differs. The last-applied spec hash and ruleset id are recorded under
`.alchemy/github-baseline/` next to the program (git-ignored). Re-running
is a no-op when GitHub already matches.

## Run it

Requirements: [Bun](https://bun.sh), and the `gh` CLI signed in to an
account that can administer the target repository.

```sh
cd infra
bun install

# Token comes from gh at runtime; it is never written to a file.
export GITHUB_TOKEN="$(gh auth token)"

# Target repo: env var or --repo= argument
export GITHUB_REPO="kotaroAi-1031/muse-repo-template"
bun run apply
# or: bun run alchemy.run.ts --repo=kotaroAi-1031/muse-tools
```

Verify afterwards:

```sh
gh api repos/<owner>/<repo>/rulesets
gh api repos/<owner>/<repo> --jq '{default_branch, delete_branch_on_merge}'
```
