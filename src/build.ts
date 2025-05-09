import * as fs from "fs";
import { StainlessV0 as Stainless } from "stainless";

type Build = Stainless.Builds.BuildObject;
export type Outcomes = Record<
  string,
  Stainless.Builds.BuildTarget.Completed.Completed
>;

// https://www.conventionalcommits.org/en/v1.0.0/
const CONVENTIONAL_COMMIT_REGEX = new RegExp(
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\(.*\))?(!?): .*$/,
);

const isValidConventionalCommitMessage = (message: string) => {
  return CONVENTIONAL_COMMIT_REGEX.test(message);
};

const MAX_POLLING_SECONDS = 10 * 60; // 10 minutes

export async function runBuilds({
  stainless,
  projectName,
  parentRevisions = [],
  mergeBranch,
  branch,
  oasPath,
  configPath,
  guessConfig = false,
  commitMessage,
}: {
  stainless: Stainless;
  projectName: string;
  parentRevisions?: Array<string | { [filepath: string]: string }>;
  mergeBranch?: string;
  branch?: string;
  oasPath?: string;
  configPath?: string;
  guessConfig?: boolean;
  commitMessage?: string;
}) {
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
  if (commitMessage && !isValidConventionalCommitMessage(commitMessage)) {
    throw new Error(
      `Invalid commit message: ${commitMessage}. Please follow the Conventional Commits format: https://www.conventionalcommits.org/en/v1.0.0/`,
    );
  }

  const parentBuilds = await findParentBuilds({
    stainless,
    projectName,
    parentRevisions,
  });
  const parentBuild = parentBuilds.find(Boolean);

  const oasContent = oasPath ? fs.readFileSync(oasPath, "utf-8") : undefined;
  let configContent = configPath
    ? fs.readFileSync(configPath, "utf-8")
    : undefined;

  if (
    await shouldResetBranch({
      stainless,
      projectName,
      parentBuild,
      branch,
    })
  ) {
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
      branch_from: parentBuild!.config_commit,
      branch: branch!,
      force: true,
    });
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

  const { outcomes, parentOutcomes } = await pollBuilds({
    stainless,
    parentBuilds,
    build,
  });

  return { outcomes, parentOutcomes };
}

async function findParentBuilds({
  stainless,
  projectName,
  parentRevisions,
}: {
  stainless: Stainless;
  projectName: string;
  parentRevisions: Array<string | { [filepath: string]: string }>;
}) {
  const parentBuilds = await Promise.all(
    parentRevisions.map(async (parentRevision) => {
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
  console.log("Parent builds found:", parentBuilds.length);

  if (parentBuild) {
    console.log("Using parent build:", parentBuild.id);
  } else {
    console.log("No parent build found");
  }

  return parentBuilds;
}

async function shouldResetBranch({
  stainless,
  projectName,
  parentBuild,
  branch,
}: {
  stainless: Stainless;
  projectName: string;
  parentBuild?: Build;
  branch?: string;
}) {
  if (!(parentBuild && branch)) {
    return false;
  }

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
      return true;
    }
  }

  return false;
}

async function pollBuilds({
  stainless,
  parentBuilds,
  build,
  maxPollingSeconds = MAX_POLLING_SECONDS,
}: {
  stainless: Stainless;
  parentBuilds: Array<Build | null>;
  build: Build;
  maxPollingSeconds?: number;
}) {
  let buildId = build.id;
  let languages = Object.keys(build.targets) as Array<
    keyof typeof build.targets
  >;
  if (buildId) {
    console.log(
      `Created build with ID ${buildId} for languages: ${languages.join(", ")}`,
    );
  } else {
    console.log(`No new build was created; exiting.`);
    return {};
  }

  let parentOutcomes: Array<Outcomes> = [];
  let outcomes: Outcomes = {};

  const pollingStart = Date.now();
  while (
    Object.keys(outcomes).length < languages.length &&
    Date.now() - pollingStart < maxPollingSeconds * 1000
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
        const buildOutput = (await stainless.builds.retrieve(buildId)).targets[
          language
        ];
        if (buildOutput?.commit.status === "completed") {
          const outcome = buildOutput?.commit;
          console.log("Build completed with outcome:", JSON.stringify(outcome));
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

  return { outcomes, parentOutcomes };
}

export function checkResults({
  outcomes,
  failRunOn,
}: {
  outcomes: Outcomes;
  failRunOn: string;
}) {
  if (failRunOn === "never") {
    return true;
  }

  const failedLanguages = Object.entries(outcomes).filter(([_, outcome]) => {
    if (!outcome.commit) return true;
    if (
      failRunOn === "error" ||
      failRunOn === "warning" ||
      failRunOn === "note"
    ) {
      if (outcome.conclusion === "error") return true;
    }
    if (failRunOn === "warning" || failRunOn === "note") {
      if (outcome.conclusion === "warning") return true;
    }
    if (failRunOn === "note") {
      if (outcome.conclusion === "note") return true;
    }
    return false;
  });

  if (failedLanguages.length > 0) {
    console.log(
      `The following languages did not build successfully: ${failedLanguages
        .map(([lang]) => lang)
        .join(", ")}`,
    );
    return false;
  }

  return true;
}
