import { StainlessV0 as Stainless } from "stainless";
import { getBooleanInput, getInput, setOutput } from "@actions/core";
import * as fs from "fs";

// https://www.conventionalcommits.org/en/v1.0.0/
const CONVENTIONAL_COMMIT_REGEX = new RegExp(
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\(.*\))?(!?): .*$/,
);

export const isValidConventionalCommitMessage = (message: string) => {
  return CONVENTIONAL_COMMIT_REGEX.test(message);
};

const MAX_POLLING_SECONDS = 10 * 60; // 10 minutes

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

    if (mergeBranch && (oasPath || configPath)) {
      throw new Error(
        "Cannot specify both merge_branch and oas_path or config_path",
      );
    }
    if (guessConfig && (configPath || !oasPath)) {
      throw new Error(
        "If guess_config is true, must have oas_path and no config_path",
      );
    }

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

    if (commitMessage && !isValidConventionalCommitMessage(commitMessage)) {
      console.error(
        `Invalid commit message: ${commitMessage}. Please follow the Conventional Commits format: https://www.conventionalcommits.org/en/v1.0.0/`,
      );
      process.exit(1);
    }

    // Find builds against parent revisions
    const parentBuilds = await Promise.all(
      parentRevisionArray.map(async (parentRevision) => {
        console.log("Searching for build against", parentRevision);

        const parentBuild = (
          await stainless.builds.list({
            project: projectName,
            limit: 1,
            ...(typeof parentRevision === "string"
              ? { branch: parentRevision }
              : {
                  revision: Object.fromEntries(
                    Object.entries(parentRevision).map(([key, hash]) => [
                      key,
                      { hash },
                    ]),
                  ),
                }),
          })
        ).data[0];

        return parentBuild ?? null;
      }),
    );
    const parentBuild = parentBuilds.find(Boolean);
    console.log("Parent builds found:", parentBuilds);

    if (parentBuild) {
      console.log("Using parent build:", parentBuild.id);
    } else {
      console.log("No parent build found");
    }

    let oasContent = oasPath ? fs.readFileSync(oasPath, "utf8") : undefined;
    let configContent = configPath
      ? fs.readFileSync(configPath, "utf8")
      : undefined;

    // If previous build on this branch is not against this revision, hard
    // reset the branch
    if (parentBuild && branch) {
      let previousBuild;

      try {
        previousBuild = (
          await stainless.projects.branches.retrieve(branch, {
            project: projectName,
          })
        )?.latest_build;
      } catch (error) {
        if (error instanceof Stainless.NotFoundError) {
          console.log(
            "Branch not found, creating it against",
            parentBuild.config_commit,
          );
          await stainless.projects.branches.create(projectName, {
            branch_from: parentBuild.config_commit,
            branch,
          });
        } else {
          throw error;
        }
      }

      if (previousBuild?.id) {
        console.log("Previous build against branch found:", previousBuild.id);
        if (previousBuild.id === parentBuild.id) {
          console.log("Branch already up to date");
        } else {
          if (!configContent) {
            if (guessConfig) {
              console.log("Guessing config before branch reset");
              configContent = Object.values(
                await stainless.projects.configs.guess(projectName, {
                  branch,
                  spec: oasContent!,
                }),
              )[0]?.content;
            } else {
              console.log("Saving config before branch reset");
              configContent = Object.values(
                await stainless.projects.configs.retrieve(projectName, {
                  branch,
                }),
              )[0]?.content;
            }
          }

          console.log("Hard resetting branch", branch);
          await stainless.projects.branches.create(projectName, {
            branch_from: previousBuild.config_commit,
            branch,
            force: true,
          });
        }
      }
    }

    // create a new build
    const build = await stainless.builds.create({
      project: projectName,
      revision: mergeBranch
        ? `${branch}..${mergeBranch}`
        : {
            ...(oasContent && {
              "openapi.yml": {
                content: oasContent,
              },
            }),
            ...(configContent && {
              "openapi.stainless.yml": {
                content: configContent,
              },
            }),
          },
      branch,
      commit_message: commitMessage,
      allow_empty: true,
    });
    let buildId = build.id;
    let languages = Object.keys(build.targets) as Array<
      keyof Stainless.Builds.BuildObject.Targets
    >;
    if (buildId) {
      console.log(
        `Created build with ID ${buildId} for languages: ${languages.join(", ")}`,
      );
    } else {
      console.log(`No new build was created; exiting.`);
      process.exit(0);
    }

    let parentOutcomes: Array<
      Record<string, Stainless.BuildTarget.Completed.Completed>
    > = [];
    let outcomes: Record<string, Stainless.BuildTarget.Completed.Completed> =
      {};

    const pollingStart = Date.now();
    while (
      Object.keys(outcomes).length < languages.length &&
      Date.now() - pollingStart < MAX_POLLING_SECONDS * 1000
    ) {
      for (const language of languages) {
        for (const [i, parentBuild] of parentBuilds.entries()) {
          if (!parentOutcomes[i]) {
            parentOutcomes[i] = {};
          }

          if (parentBuild && !(language in parentOutcomes[i])) {
            const parentBuildOutput = parentBuild.targets[language];
            if (parentBuildOutput?.commit.status === "completed") {
              const parentOutcome = parentBuildOutput?.commit;
              console.log(
                `Parent build ${i + 1} completed with outcome:`,
                JSON.stringify(parentOutcome),
              );
              parentOutcomes[i][language] = parentOutcome.completed;
            } else {
              console.log(
                `Parent build ${i + 1} has status ${parentBuildOutput?.commit.status} for ${language}`,
              );
            }
          }
        }

        if (!(language in outcomes)) {
          const buildOutput = (await stainless.builds.retrieve(buildId))
            .targets[language];
          if (buildOutput?.commit.status === "completed") {
            const outcome = buildOutput?.commit;
            console.log(
              "Build completed with outcome:",
              JSON.stringify(outcome),
            );
            outcomes[language] = outcome.completed;
          } else {
            console.log(
              `Build has status ${buildOutput?.commit.status} for ${language}`,
            );
          }
        }
      }

      // wait a bit before polling again
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const languagesWithoutOutcome = languages.filter(
      (language) => !(language in outcomes),
    );
    for (const language of languagesWithoutOutcome) {
      outcomes[language] = {
        conclusion: "timed_out",
        commit: null,
        merge_conflict_pr: null,
      };
    }

    setOutput("results", { outcomes, parentOutcomes });
  } catch (error) {
    console.error("Error interacting with API:", error);
    process.exit(1);
  }
}

main();
