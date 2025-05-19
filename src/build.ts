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

const POLLING_INTERVAL_SECONDS = 5;
const MAX_POLLING_SECONDS = 10 * 60; // 10 minutes

export async function runBuilds({
  stainless,
  projectName,
  baseRevision,
  baseBranch,
  mergeBranch,
  branch,
  oasPath,
  configPath,
  guessConfig = false,
  commitMessage,
  outputDir,
}: {
  stainless: Stainless;
  projectName: string;
  baseRevision?: string;
  baseBranch?: string;
  mergeBranch?: string;
  branch?: string;
  oasPath?: string;
  configPath?: string;
  guessConfig?: boolean;
  commitMessage?: string;
  outputDir?: string;
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
  if (baseRevision && mergeBranch) {
    throw new Error("Cannot specify both base_revision and merge_branch");
  }
  if (commitMessage && !isValidConventionalCommitMessage(commitMessage)) {
    if (branch === "main") {
      throw new Error(
        `Invalid commit message: "${commitMessage}". Please follow the Conventional Commits format: https://www.conventionalcommits.org/en/v1.0.0/`,
      );
    } else {
      console.warn(
        `Commit message: "${commitMessage}" is not in Conventional Commits format: https://www.conventionalcommits.org/en/v1.0.0/, using anyway`,
      );
    }
  }

  const oasContent = oasPath ? fs.readFileSync(oasPath, "utf-8") : undefined;
  let configContent = configPath
    ? fs.readFileSync(configPath, "utf-8")
    : undefined;

  if (!baseRevision) {
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

    const { outcomes, documentedSpec } = await pollBuild({ stainless, build });

    let documentedSpecPath = null;
    if (outputDir && documentedSpec) {
      documentedSpecPath = `${outputDir}/openapi.documented.yml`;
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(documentedSpecPath, documentedSpec);
    }

    return {
      baseOutcomes: null,
      outcomes,
      documentedSpecPath,
    };
  }

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

  console.log(`Hard resetting ${branch} to ${baseRevision}`);
  const { config_commit } = await stainless.projects.branches.create(
    projectName,
    {
      branch_from: baseRevision,
      branch: branch!,
      force: true,
    },
  );
  console.log(`Hard reset ${branch}, now at ${config_commit.sha}`);

  const { base, head } = await stainless.builds.compare({
    project: projectName,
    base: {
      revision: baseRevision,
      branch: baseBranch,
      commit_message: commitMessage,
    },
    head: {
      revision: {
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
    },
  });

  const results = await Promise.all([
    pollBuild({ stainless, build: base }),
    pollBuild({ stainless, build: head }),
  ]);

  let documentedSpecPath = null;
  if (outputDir && results[1].documentedSpec) {
    documentedSpecPath = `${outputDir}/openapi.documented.yml`;
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(documentedSpecPath, results[1].documentedSpec);
  }

  return {
    baseOutcomes: results[0].outcomes,
    outcomes: results[1].outcomes,
    documentedSpecPath,
  };
}

async function pollBuild({
  stainless,
  build,
  pollingIntervalSeconds = POLLING_INTERVAL_SECONDS,
  maxPollingSeconds = MAX_POLLING_SECONDS,
}: {
  stainless: Stainless;
  build: Build;
  pollingIntervalSeconds?: number;
  maxPollingSeconds?: number;
}) {
  let outcomes: Outcomes = {};
  let documentedSpec: string | null = null;

  let buildId = build.id;
  let languages = Object.keys(build.targets) as Array<
    keyof typeof build.targets
  >;
  if (buildId) {
    console.log(
      `[${buildId}] Created build against ${build.config_commit} for languages: ${languages.join(", ")}`,
    );
  } else {
    console.log(`No new build was created; exiting.`);
    return { outcomes, documentedSpec };
  }

  const pollingStart = Date.now();
  while (
    Object.keys(outcomes).length < languages.length &&
    Date.now() - pollingStart < maxPollingSeconds * 1000
  ) {
    const build = await stainless.builds.retrieve(buildId);
    for (const language of languages) {
      if (!(language in outcomes)) {
        const buildOutput = build.targets[language];
        if (buildOutput?.commit.status === "completed") {
          const outcome = buildOutput?.commit;
          console.log(
            `[${buildId}] Build completed for ${language} with outcome:`,
            JSON.stringify(outcome),
          );
          outcomes[language] = outcome.completed;
        } else {
          console.log(
            `[${buildId}] Build for ${language} has status ${buildOutput?.commit.status}`,
          );
        }
      }
    }

    // API only returns "content" for now; need to support "url" in the future
    if (!documentedSpec && build.documented_spec?.type === "content") {
      documentedSpec = build.documented_spec.content;
    }

    // wait a bit before polling again
    await new Promise((resolve) =>
      setTimeout(resolve, pollingIntervalSeconds * 1000),
    );
  }

  const languagesWithoutOutcome = languages.filter(
    (language) => !(language in outcomes),
  );
  for (const language of languagesWithoutOutcome) {
    console.log(
      `[${buildId}] Build for ${language} timed out after ${maxPollingSeconds} seconds`,
    );
    outcomes[language] = {
      conclusion: "timed_out",
      commit: null,
      merge_conflict_pr: null,
    };
  }

  return { outcomes, documentedSpec };
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
