import { getBooleanInput, getInput, setOutput } from "@actions/core";
import { StainlessV0 as Stainless } from "stainless";
import { runBuilds } from "./build";

async function main() {
  try {
    const apiKey = getInput("stainless_api_key", { required: true });
    const oasPath = getInput("oas_path", { required: false }) || undefined;
    const configPath =
      getInput("config_path", { required: false }) || undefined;
    const projectName = getInput("project_name", { required: true });
    const commitMessage =
      getInput("commit_message", { required: false }) || undefined;
    const guessConfig = getBooleanInput("guess_config", { required: false });
    const branch = getInput("branch", { required: false }) || undefined;
    const mergeBranch =
      getInput("merge_branch", { required: false }) || undefined;
    const parentRevisionRaw =
      getInput("parent_revision", { required: false }) || undefined;

    const parentRevisionArray = (() => {
      if (!parentRevisionRaw) {
        return [];
      }
      const result = JSON.parse(parentRevisionRaw);
      if (!Array.isArray(result)) {
        throw new Error("parent_revision must be an array");
      }
      if (
        !result.every(
          (x) =>
            typeof x === "string" ||
            (typeof x === "object" &&
              Object.entries(x).every(
                ([key, value]) =>
                  typeof key === "string" && typeof value === "string",
              )),
        )
      ) {
        throw new Error(
          "parent_revision must be an array of strings or objects with string keys and string values",
        );
      }
      if (branch === "main" && result.length > 0) {
        throw new Error("parent_revision must be empty when branch is 'main'");
      }
      return result as Array<string | { [filepath: string]: string }>;
    })();

    const stainless = new Stainless({ apiKey, logLevel: "warn" });

    const { parentOutcomes, outcomes } = await runBuilds({
      stainless,
      projectName,
      parentRevisions: parentRevisionArray,
      mergeBranch,
      branch,
      oasPath,
      configPath,
      guessConfig,
      commitMessage,
    });

    setOutput("outcomes", outcomes);
    setOutput("parent_outcomes", parentOutcomes);
  } catch (error) {
    console.error("Error interacting with API:", error);
    process.exit(1);
  }
}

main();
