/**
 * GitHub repository baseline, managed declaratively with Alchemy v2.
 *
 * Desired state (deliberately NOT strict — this is a floor, not a cage):
 * - Repository: default branch is `main`; head branches are deleted
 *   automatically after a merge. Merge / squash / rebase strategies are
 *   left at GitHub defaults and are NOT managed here.
 * - One branch ruleset named `baseline-protection` on the default branch
 *   that only:
 *     - blocks branch deletion            (rule type: `deletion`)
 *     - blocks force pushes               (rule type: `non_fast_forward`)
 *   No required reviews, no required status checks, no bypass actors.
 *
 * How this is implemented (read before changing):
 * Alchemy v2 (alchemy@2.0.0-beta.84) ships providers for AWS, Cloudflare
 * and others, but has NO built-in GitHub repository / ruleset resource,
 * and its Resource/Provider API (Effect v4 beta) requires a full
 * provider layer per resource type. So instead of a fake Resource class,
 * this program declares an Alchemy Stack (local state store) whose body
 * runs an idempotent converge against the GitHub REST API:
 * read current state -> diff against the desired state below -> write
 * only what differs. The last-applied spec (with a SHA-256 hash of the
 * desired state and the ruleset id) is recorded under `.alchemy/` next
 * to this file, alongside Alchemy's own local state, so re-runs are
 * no-ops when GitHub already matches.
 *
 * The GitHub token is read from the GITHUB_TOKEN environment variable at
 * runtime (`gh auth token`). It is never written to any file or state.
 *
 * Usage: see README.md in this directory.
 */
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Desired state
// ---------------------------------------------------------------------------

const RULESET_NAME = "baseline-protection";

const desiredRepoSettings = {
  default_branch: "main",
  delete_branch_on_merge: true,
  // allow_merge_commit / allow_squash_merge / allow_rebase_merge are
  // intentionally absent: they stay at GitHub defaults, unmanaged.
} as const;

const desiredRuleset = {
  name: RULESET_NAME,
  target: "branch",
  enforcement: "active",
  conditions: {
    ref_name: {
      include: ["~DEFAULT_BRANCH"],
      exclude: [] as string[],
    },
  },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  bypass_actors: [] as unknown[],
} as const;

// ---------------------------------------------------------------------------
// GitHub REST client (token only from the environment, never persisted)
// ---------------------------------------------------------------------------

const token = () => {
  const t = process.env.GITHUB_TOKEN;
  if (!t) {
    throw new Error(
      "GITHUB_TOKEN is not set. Run: export GITHUB_TOKEN=\"$(gh auth token)\"",
    );
  }
  return t;
};

async function gh<T>(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "muse-repo-template-alchemy",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(
      `GitHub API ${method} ${apiPath} failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Converge: make GitHub match the desired state, idempotently
// ---------------------------------------------------------------------------

interface ConvergeResult {
  repo: string;
  repoSettingsChanged: boolean;
  rulesetAction: "created" | "updated" | "unchanged";
  rulesetId: number;
}

async function converge(owner: string, repo: string): Promise<ConvergeResult> {
  const base = `/repos/${owner}/${repo}`;

  // 1. Repository settings
  const current = await gh<Record<string, unknown>>("GET", base);
  const patch: Record<string, unknown> = {};
  for (const [key, want] of Object.entries(desiredRepoSettings)) {
    if (current[key] !== want) patch[key] = want;
  }
  let repoSettingsChanged = false;
  if (Object.keys(patch).length > 0) {
    await gh("PATCH", base, patch);
    repoSettingsChanged = true;
  }

  // 2. Baseline ruleset (find by name, create or update in place)
  const existing = await gh<Array<{ id: number; name: string }>>(
    "GET",
    `${base}/rulesets`,
  );
  const found = existing.find((r) => r.name === RULESET_NAME);
  let rulesetAction: ConvergeResult["rulesetAction"] = "unchanged";
  let rulesetId: number;
  if (!found) {
    const created = await gh<{ id: number }>("POST", `${base}/rulesets`, desiredRuleset);
    rulesetId = created.id;
    rulesetAction = "created";
  } else {
    rulesetId = found.id;
    const detail = await gh<{
      enforcement: string;
      conditions: unknown;
      rules: Array<{ type: string }>;
    }>("GET", `${base}/rulesets/${found.id}`);
    const sameRules =
      JSON.stringify(detail.rules.map((r) => r.type).sort()) ===
      JSON.stringify(desiredRuleset.rules.map((r) => r.type).sort());
    const sameSet = (a: string[] = [], b: readonly string[] = []) =>
      JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const detailConditions = detail.conditions as {
      ref_name?: { include?: string[]; exclude?: string[] };
    };
    const sameConditions =
      sameSet(detailConditions.ref_name?.include, desiredRuleset.conditions.ref_name.include) &&
      sameSet(detailConditions.ref_name?.exclude, desiredRuleset.conditions.ref_name.exclude);
    if (!sameRules || !sameConditions || detail.enforcement !== "active") {
      await gh("PUT", `${base}/rulesets/${found.id}`, desiredRuleset);
      rulesetAction = "updated";
    }
  }

  // 3. Record last-applied state under .alchemy/ (Alchemy's local state
  //    directory convention). Contains no credentials.
  const specHash = createHash("sha256")
    .update(JSON.stringify({ desiredRepoSettings, desiredRuleset }))
    .digest("hex");
  const stateDir = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    ".alchemy",
    "github-baseline",
  );
  await mkdir(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, `${owner}__${repo}.json`);
  let previous: unknown = null;
  try {
    previous = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    previous = null;
  }
  await writeFile(
    stateFile,
    JSON.stringify(
      {
        repo: `${owner}/${repo}`,
        specHash,
        rulesetId,
        rulesetName: RULESET_NAME,
        repoSettingsChanged,
        rulesetAction,
        previous,
        appliedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );

  return { repo: `${owner}/${repo}`, repoSettingsChanged, rulesetAction, rulesetId };
}

// ---------------------------------------------------------------------------
// Alchemy stack + direct-run entry point
// ---------------------------------------------------------------------------

function targetRepo(): { owner: string; repo: string } {
  const arg = process.argv.find((a) => a.startsWith("--repo="));
  const value = arg?.slice("--repo=".length) ?? process.env.GITHUB_REPO;
  if (!value || !value.includes("/")) {
    throw new Error(
      "Target repo missing. Set GITHUB_REPO=owner/repo or pass --repo=owner/repo",
    );
  }
  const [owner, repo] = value.split("/");
  return { owner: owner!, repo: repo! };
}

const program = Effect.gen(function* () {
  const { owner, repo } = targetRepo();
  const result = yield* Effect.tryPromise(() => converge(owner, repo));
  console.log(
    `[github-baseline] ${result.repo}: repo settings ${
      result.repoSettingsChanged ? "updated" : "already matched"
    }, ruleset "${RULESET_NAME}" (id=${result.rulesetId}) ${result.rulesetAction}`,
  );
  return result;
});

// The Alchemy Stack declaration: local state store, no cloud providers
// (the converge above talks to the GitHub API directly, as documented).
export default Alchemy.Stack(
  "github-repo-baseline",
  {
    providers: Layer.empty,
    state: Alchemy.localState(),
  },
  program,
);

// Direct run without the Alchemy CLI: `bun run alchemy.run.ts`
// (import.meta.main is true only when this file is the entry point,
// not when the Alchemy CLI imports it as a stack).
if ((import.meta as { main?: boolean }).main) {
  await Effect.runPromise(program);
}
