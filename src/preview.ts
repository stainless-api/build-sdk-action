import { getBooleanInput, getInput, setOutput } from "@actions/core";
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
    const defaultBranch = getInput("default_branch", { required: true });
    const headSha = getInput("head_sha", { required: true });
    const branch = getInput("branch", { required: true });

    if (makeComment && !githubToken) {
      throw new Error("github_token is required to make a comment");
    }

    const stainless = new Stainless({ apiKey, logLevel: "warn" });

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

    const parentRevisions = await computeParentRevisions({
      mergeBaseSha,
      nonMainBaseRef,
      oasPath,
      configPath,
    });

    // Checkout HEAD for runBuilds to pull the files of:
    await exec.exec("git", ["checkout", headSha]);

    const builds = await runBuilds({
      stainless,
      oasPath,
      configPath,
      projectName,
      parentRevisions,
      branch,
      guessConfig: !configPath,
      commitMessage,
    });

    const outcomes = builds.outcomes!;
    const parentOutcomes = builds.parentOutcomes?.find(Boolean);

    setOutput("outcomes", outcomes);
    setOutput("parent_outcomes", parentOutcomes);

    if (makeComment) {
      const commentBody = generatePreviewComment({
        outcomes,
        parentOutcomes,
        orgName,
        projectName,
      });

      await upsertComment({ body: commentBody, token: githubToken });
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
  await exec.exec("git", ["fetch", "--depth=1", "origin", baseSha]);

  let mergeBaseSha;

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const output = await exec.getExecOutput("git", [
        "merge-base",
        headSha,
        baseSha,
      ]);
      mergeBaseSha = output.stdout.trim();
      if (mergeBaseSha) break;
    } catch {}

    // deepen fetch until we find merge base
    await exec.exec("git", [
      "fetch",
      "--quiet",
      "--deepen=10",
      "origin",
      baseSha,
      headSha,
    ]);
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

async function computeParentRevisions({
  mergeBaseSha,
  nonMainBaseRef,
  oasPath,
  configPath,
}: {
  mergeBaseSha?: string;
  nonMainBaseRef?: string;
  oasPath?: string;
  configPath?: string;
}) {
  const result: Array<string | Record<string, string>> = [];

  if (mergeBaseSha) {
    let hashes: Record<string, string> = {};

    await exec.exec("git", ["checkout", mergeBaseSha]);

    for (const [path, file] of [
      [oasPath, "openapi.yml"],
      [configPath, "openapi.stainless.yml"],
    ]) {
      if (path) {
        await exec
          .getExecOutput("md5sum", [path])
          .then(({ stdout }) => {
            hashes[file!] = stdout.split(" ")[0];
          })
          .catch(() => {
            console.log(`File ${path} does not exist at merge base.`);
          });
      }
    }

    result.push(hashes);
  }

  if (nonMainBaseRef) {
    result.push(nonMainBaseRef);
  }

  result.push("main");

  console.log("Parent revisions:", result);

  return result;
}

main();
