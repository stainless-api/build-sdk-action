import { getBooleanInput, getInput, setOutput } from "@actions/core";
import { StainlessV0 as Stainless } from "stainless";
import { runBuilds } from "./build";

async function main() {
  try {
    const apiKey = getInput("stainless_api_key", { required: true });
    const oasPath = getInput("oas_path", { required: false }) || undefined;
    const configPath =
      getInput("config_path", { required: false }) || undefined;
    const projectName = getInput("project", { required: true });
    const commitMessage =
      getInput("commit_message", { required: false }) || undefined;
    const guessConfig = getBooleanInput("guess_config", { required: false });
    const branch = getInput("branch", { required: false }) || undefined;
    const mergeBranch =
      getInput("merge_branch", { required: false }) || undefined;
    const baseRevision =
      getInput("base_revision", { required: false }) || undefined;
    const baseBranch =
      getInput("base_branch", { required: false }) || undefined;

    const stainless = new Stainless({ apiKey, logLevel: "warn" });

    const { baseOutcomes, outcomes } = await runBuilds({
      stainless,
      projectName,
      baseRevision,
      baseBranch,
      mergeBranch,
      branch,
      oasPath,
      configPath,
      guessConfig,
      commitMessage,
    });

    setOutput("outcomes", outcomes);
    setOutput("base_outcomes", baseOutcomes);
  } catch (error) {
    console.error("Error interacting with API:", error);
    process.exit(1);
  }
}

main();
