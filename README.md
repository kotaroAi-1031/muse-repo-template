# muse-repo-template

The template repository for every repository Muse creates for this
user. It bakes in the standing guardrails so a new repo starts safe
without being hard to operate:

- **Betterleaks via Lefthook** — commits and pushes are scanned for
  secrets locally, before anything reaches GitHub.
- **Dependabot** — weekly update PRs for GitHub Actions (the only
  ecosystem every repo here has); examples for other ecosystems are
  commented into `.github/dependabot.yml`.
- **Hardened CI lint** (`.github/workflows/ci-lint.yml`) — read-only
  top-level permissions, every action pinned to a full commit SHA,
  every tool binary pinned and SHA-256-verified, running:
  - **jactionlint** (the actionlint fork that also carries
    zizmor-style security rules) at its strictest profile
    (`pedantic`, `--strict-exit`, offline), with its shellcheck and
    pyflakes integrations — every rule on,
  - **sisakulint** (GitHub Actions SAST) with every rule enabled
    except the ones that duplicate a jactionlint rule (each exception
    is documented in the workflow, with the jactionlint rule that
    covers it); its taint-propagation rules stay on,
  - a **Betterleaks** scan of the git history.
- **GitHub settings as code** — repository settings and one baseline
  branch ruleset are managed declaratively by the Alchemy v2 program
  in `infra/` (see `infra/README.md`). The ruleset is deliberately
  minimal: it only blocks force pushes and branch deletion on the
  default branch. No required reviews, no required status checks.

## Create a repository from this template

```sh
gh repo create kotaroAi-1031/<new-repo> --public --template kotaroAi-1031/muse-repo-template
# or in the GitHub UI: "Use this template" on this repository's page.
```

## First steps after cloning

```sh
lefthook install   # activate the Betterleaks pre-commit / pre-push hooks
```

Then apply the GitHub baseline settings to the new repository:

```sh
cd infra
pnpm install
export GITHUB_TOKEN="$(gh auth token)"
GITHUB_REPO="kotaroAi-1031/<new-repo>" pnpm run apply
```

## Standing rules

- **Never commit secrets** — no tokens, keys, credential files, or
  `.env` files, in any repository, ever. Credentials come from the
  Secure Vault or a connector at runtime. Betterleaks guards commits
  and pushes; CI scans history again.
- Hooks and tooling live in `~/workspace/tools/bin/` on the VM
  (lefthook, betterleaks, jactionlint, sisakulint); this template is
  the source of truth for how they are wired into a repository.
- Keep the baseline loose. Extra rules (required reviews, status
  checks) are added per repository when they earn their keep — not
  here, where they would tax every repo created from this template.
