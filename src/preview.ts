import { getInput } from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import { StainlessV0 as Stainless } from "stainless";
import { checkResults, runBuilds } from "./build";
import { isConfigChanged } from "./config";
import { generatePreviewComment, upsertComment } from "./comment";

async function getParentCommits() {
  // Get HEAD and BASE shas
  const HEAD = github.context.payload.pull_request!.head.sha;
  const BASE = github.context.payload.pull_request!.base.sha;

  await exec.exec("git", ["fetch", "--depth=1", "origin", BASE]);

  let mergeBaseSha;

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const output = await exec.getExecOutput("git", [
        "merge-base",
        HEAD,
        BASE,
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
      BASE,
      HEAD,
    ]);
  }

  if (!mergeBaseSha) {
    throw new Error("Could not determine merge base SHA");
  }

  console.log(`Merge base: ${mergeBaseSha}`);

  let nonMainBaseRef;
  const baseRef = github.context.payload.pull_request!.base.ref;
  const defaultBranch = github.context.payload.repository!.default_branch;

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

  await exec.exec("git", [
    "checkout",
    github.context.payload.pull_request!.head.sha,
  ]);
  console.log("Parent revisions:", result);

  return result;
}

async function main() {
  try {
    // Get inputs
    const apiKey = getInput("stainless_api_key", { required: true });
    const oasPath = getInput("oas_path", { required: true });
    const configPath =
      getInput("config_path", { required: false }) || undefined;
    const projectName = getInput("project_name", { required: true });
    const orgName = getInput("org_name", { required: true });
    const failRunOn = getInput("fail_run_on", { required: false }) || "error";

    const stainless = new Stainless({ apiKey, logLevel: "warn" });

    const { mergeBaseSha, nonMainBaseRef } = await getParentCommits();

    const configChanged = await isConfigChanged({
      before: mergeBaseSha,
      after: github.context.payload.pull_request!.head.sha,
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

    const builds = await runBuilds({
      stainless,
      oasPath,
      configPath,
      projectName,
      parentRevisions,
      branch: `preview/${github.context.payload.pull_request!.head.ref}`,
      guessConfig: !configPath,
      commitMessage: github.context.payload.pull_request!.title,
    });

    const outcomes = builds.outcomes!;
    const parentOutcomes = builds.parentOutcomes?.find(Boolean);

    const commentBody = generatePreviewComment({
      outcomes,
      parentOutcomes,
      orgName,
      projectName,
    });

    await upsertComment({ body: commentBody });

    if (!checkResults({ outcomes, failRunOn })) {
      process.exit(1);
    }
  } catch (error) {
    console.error("Error in preview action:", error);
    process.exit(1);
  }
}

main();
