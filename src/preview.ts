import {
  endGroup,
  getBooleanInput,
  getInput,
  setOutput,
  startGroup,
} from "@actions/core";
import * as exec from "@actions/exec";
import { StainlessV0 as Stainless } from "stainless";
import { checkResults, runBuilds } from "./build";
import { isConfigChanged } from "./config";
import { generatePreviewComment, upsertComment } from "./comment";

async function main() {
  try {
    const apiKey = getInput("stainless_api_key", { required: true });
    const orgName = getInput("org", { required: true });
    const projectName = getInput("project", { required: true });
    const oasPath = getInput("oas_path", { required: true });
    const configPath =
      getInput("config_path", { required: false }) || undefined;
    const commitMessage = getInput("commit_message", { required: true });
    const failRunOn = getInput("fail_on", { required: true }) || "error";
    const makeComment = getBooleanInput("make_comment", { required: true });
    const githubToken = getInput("github_token", { required: false });
    const baseSha = getInput("base_sha", { required: true });
    const baseRef = getInput("base_ref", { required: true });
    const baseBranch = getInput("base_branch", { required: true });
    const defaultBranch = getInput("default_branch", { required: true });
    const headSha = getInput("head_sha", { required: true });
    const branch = getInput("branch", { required: true });

    if (makeComment && !githubToken) {
      throw new Error("github_token is required to make a comment");
    }

    const stainless = new Stainless({ apiKey, logLevel: "warn" });

    startGroup("Getting parent revision");

    const { mergeBaseSha, nonMainBaseRef } = await getParentCommits({
      baseSha,
      headSha,
      baseRef,
      defaultBranch,
    });

    const configChanged = await isConfigChanged({
      before: mergeBaseSha,
      after: headSha,
      oasPath,
      configPath,
    });

    if (!configChanged) {
      console.log("No config files changed, skipping preview");
      return;
    }

    const baseRevision = await computeBaseRevision({
      stainless,
      projectName,
      mergeBaseSha,
      nonMainBaseRef,
      oasPath,
      configPath,
    });

    endGroup();
    startGroup("Running builds");

    // Checkout HEAD for runBuilds to pull the files of:
    await exec.exec("git", ["checkout", headSha], { silent: true });

    const { outcomes, baseOutcomes } = await runBuilds({
      stainless,
      oasPath,
      configPath,
      projectName,
      baseRevision,
      baseBranch,
      branch,
      guessConfig: !configPath,
      commitMessage,
    });

    setOutput("outcomes", outcomes);
    setOutput("base_outcomes", baseOutcomes);

    endGroup();

    if (makeComment) {
      startGroup("Creating comment");

      const commentBody = generatePreviewComment({
        outcomes,
        baseOutcomes,
        orgName,
        projectName,
      });

      await upsertComment({ body: commentBody, token: githubToken });

      endGroup();
    }

    if (!checkResults({ outcomes, failRunOn })) {
      process.exit(1);
    }
  } catch (error) {
    console.error("Error in preview action:", error);
    process.exit(1);
  }
}

async function getParentCommits({
  baseSha,
  headSha,
  baseRef,
  defaultBranch,
}: {
  baseSha: string;
  headSha: string;
  baseRef: string;
  defaultBranch: string;
}) {
  await exec.exec("git", ["fetch", "--depth=1", "origin", baseSha], {
    silent: true,
  });

  let mergeBaseSha;

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const output = await exec.getExecOutput(
        "git",
        ["merge-base", headSha, baseSha],
        { silent: true },
      );
      mergeBaseSha = output.stdout.trim();
      if (mergeBaseSha) break;
    } catch {}

    // deepen fetch until we find merge base
    await exec.exec(
      "git",
      ["fetch", "--quiet", "--deepen=10", "origin", baseSha, headSha],
      { silent: true },
    );
  }

  if (!mergeBaseSha) {
    throw new Error("Could not determine merge base SHA");
  }

  console.log(`Merge base: ${mergeBaseSha}`);

  let nonMainBaseRef;

  if (baseRef !== defaultBranch) {
    nonMainBaseRef = `preview/${baseRef}`;
    console.log(`Non-main base ref: ${nonMainBaseRef}`);
  }

  return { mergeBaseSha, nonMainBaseRef };
}

async function computeBaseRevision({
  stainless,
  projectName,
  mergeBaseSha,
  nonMainBaseRef,
  oasPath,
  configPath,
}: {
  stainless: Stainless;
  projectName: string;
  mergeBaseSha?: string;
  nonMainBaseRef?: string;
  oasPath?: string;
  configPath?: string;
}) {
  if (mergeBaseSha) {
    let hashes: Record<string, { hash: string }> = {};

    await exec.exec("git", ["checkout", mergeBaseSha], { silent: true });

    for (const [path, file] of [
      [oasPath, "openapi.yml"],
      [configPath, "openapi.stainless.yml"],
    ]) {
      if (path) {
        await exec
          .getExecOutput("md5sum", [path], { silent: true })
          .then(({ stdout }) => {
            hashes[file!] = { hash: stdout.split(" ")[0] };
          })
          .catch(() => {
            console.log(`File ${path} does not exist at merge base.`);
          });
      }
    }

    const configCommit = (
      await stainless.builds.list({
        project: projectName,
        revision: hashes,
        limit: 1,
      })
    ).data[0]?.config_commit;

    if (configCommit) {
      console.log(`Found base via merge base SHA: ${configCommit}`);
      return configCommit;
    }
  }

  if (nonMainBaseRef) {
    const configCommit = (
      await stainless.builds.list({
        project: projectName,
        branch: nonMainBaseRef,
        limit: 1,
      })
    ).data[0]?.config_commit;

    if (configCommit) {
      console.log(`Found base via non-main base ref: ${configCommit}`);
      return configCommit;
    }
  }

  const configCommit = (
    await stainless.builds.list({
      project: projectName,
      branch: "main",
      limit: 1,
    })
  ).data[0]?.config_commit;

  if (!configCommit) {
    throw new Error("Could not determine base revision");
  }

  console.log(`Found base via main branch: ${configCommit}`);
  return configCommit;
}

main();
