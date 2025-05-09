import { getInput, setOutput } from "@actions/core";
import * as github from "@actions/github";
import { StainlessV0 as Stainless } from "stainless";
import { isConfigChanged } from "./config";
import { checkResults, runBuilds } from "./build";
import { generateMergeComment, upsertComment } from "./comment";

async function main() {
  try {
    // Get inputs
    const apiKey = getInput("stainless_api_key", { required: true });
    const oasPath = getInput("oas_path", { required: true });
    const configPath =
      getInput("config_path", { required: false }) || undefined;
    const projectName = getInput("project_name", { required: true });
    const orgName = getInput("org_name", { required: false });
    const failRunOn = getInput("fail_run_on", { required: true }) || "error";
    const githubToken = getInput("github_token", { required: false });

    const stainless = new Stainless({ apiKey, logLevel: "warn" });

    const configChanged = await isConfigChanged({
      before: `${github.context.sha}^1`,
      after: github.context.sha,
      oasPath,
      configPath,
    });

    if (!configChanged) {
      console.log("No config files changed, skipping preview");
      return;
    }

    const builds = await runBuilds({
      stainless,
      projectName,
      commitMessage: github.context.payload.pull_request!.title,
      branch: "main",
      mergeBranch: `preview/${github.context.payload.pull_request!.head.ref}`,
      guessConfig: false,
    });

    const outcomes = builds.outcomes!;

    setOutput("outcomes", outcomes);

    if (orgName && githubToken) {
      const commentBody = generateMergeComment({
        outcomes,
        orgName,
        projectName,
      });

      await upsertComment({ body: commentBody, token: githubToken });
    }

    if (!checkResults({ outcomes, failRunOn })) {
      process.exit(1);
    }
  } catch (error) {
    console.error("Error in merge action:", error);
    process.exit(1);
  }
}

main();
