import { StainlessV0 as Stainless } from "stainless";
import { getInput, setOutput } from "@actions/core";
import * as fs from "fs";
import * as path from "path";

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

    const stainless = new Stainless({
      apiKey: apiKey,
      logLevel: "warn",
    });

    if (commitMessage && !isValidConventionalCommitMessage(commitMessage)) {
      console.error(
        "Invalid commit message format. Please follow the Conventional Commits format: https://www.conventionalcommits.org/en/v1.0.0/",
      );
      process.exit(1);
    }

    // Attempt to find a build against a parent revision
    let parentBuildId;
    for (const parentRevision of parentRevisionArray) {
      console.log("Searching for build against", parentRevision);
      if (typeof parentRevision === "string") {
        parentBuildId = (
          await stainless.builds.list({
            project: projectName,
            revision: parentRevision,
            limit: 1,
          })
        ).data[0]?.id;
        if (parentBuildId) {
          break;
        }
      } else {
        parentBuildId = (
          await stainless.builds.list({
            project: projectName,
            revision: Object.fromEntries(
              Object.entries(parentRevision).map(([key, hash]) => [
                key,
                { hash },
              ]),
            ),
            limit: 1,
          })
        )?.data[0]?.id;
        if (parentBuildId) {
          break;
        }
      }
    }
    if (parentRevisionArray.length > 0) {
      if (parentBuildId) {
        console.log("Found parent build:", parentBuildId);
      } else {
        console.log("No parent build found.");
      }
    }

    // If previous build on this branch is not against this revision, hard
    // reset the branch
    if (parentBuildId && branch) {
      const previousBuild = (
        await stainless.projects.branches.retrieve(branch, {
          project: projectName,
        })
      )?.latest_build;
      if (previousBuild?.id) {
        console.log("Previous build against branch found:", previousBuild.id);
        if (previousBuild.id === parentBuildId) {
          console.log("Branch already up to date");
        } else {
          console.log("Hard resetting branch", branch);
          await stainless.projects.branches.create(projectName, {
            branch_from: previousBuild.config_commit,
            branch: branch,
          });
        }
      }
    }

    const oasBuffer = oasPath ? fs.readFileSync(oasPath) : undefined;
    const configBuffer = configPath ? fs.readFileSync(configPath) : undefined;

    // create a new build
    const build = await stainless.builds.create({
      project: projectName,
      revision: mergeBranch
        ? `${branch}..${mergeBranch}`
        : {
            ...(oasPath &&
              oasBuffer && {
                [path.basename(oasPath)]: {
                  content: oasBuffer.toString("utf-8"),
                },
              }),
            ...(configPath &&
              configBuffer && {
                [path.basename(configPath)]: {
                  content: configBuffer.toString("utf-8"),
                },
              }),
          },
      branch,
      commit_message: commitMessage,
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

    let parentOutcomes: Record<
      string,
      Stainless.BuildTarget.Completed.Completed
    > = {};
    let outcomes: Record<string, Stainless.BuildTarget.Completed.Completed> =
      {};

    const pollingStart = Date.now();
    while (
      Object.keys(outcomes).length < languages.length &&
      Date.now() - pollingStart < MAX_POLLING_SECONDS * 1000
    ) {
      for (const language of languages) {
        if (!(language in parentOutcomes) && parentBuildId) {
          const parentBuildOutput = (
            await stainless.builds.retrieve(parentBuildId)
          ).targets[language];
          if (parentBuildOutput?.commit.status === "completed") {
            const parentOutcome = parentBuildOutput?.commit;
            console.log(
              "Parent build completed with outcome:",
              JSON.stringify(parentOutcome),
            );
            parentOutcomes[language] = parentOutcome.completed;
          } else {
            console.log(
              `Parent build has status ${parentBuildOutput?.commit.status} for ${language}`,
            );
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
