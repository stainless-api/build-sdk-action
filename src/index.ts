import { Stainless } from 'stainless';
import { getBooleanInput, getInput } from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

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
    const stainless_api_key = getInput('stainless_api_key', { required: true });
    const projectName = getInput('project_name', { required: true });
    const oasPath = getInput('oas_path', { required: true });
    const configPath = getInput('config_path', { required: false }) || undefined;
    const oldOasHash = getInput('old_oas_hash', { required: false }) || undefined;
    const oldConfigHash = getInput('old_config_hash', { required: false }) || undefined;
    const branch = getInput('branch', { required: false }) || undefined;
    const commitMessage = getInput('commit_message', { required: false }) || undefined;
    const guessConfig = getBooleanInput('guess_config', { required: false });

    const stainless = new Stainless({ apiKey: stainless_api_key });

    if (commitMessage && !isValidConventionalCommitMessage(commitMessage)) {        
      console.error('Invalid commit message format. Please follow the Conventional Commits format: https://www.conventionalcommits.org/en/v1.0.0/');
      process.exit(1);
    }

    // attempt to find a parent build
    const recentBuilds = await stainless.builds.list({
        project: projectName,
        spec_hash: oldOasHash,
        config_hash: oldConfigHash,
        limit: 1,
    });
    const parentBuildId = recentBuilds[0]?.id || undefined;
    if (parentBuildId) {
      console.log("Found parent build:", parentBuildId);
    } else {
      console.log("No parent build found.");
    }

    // create a new build
    const build = await stainless.builds.create({
      project: projectName,
      oasSpec: new File(
        [fs.readFileSync(oasPath)],
        path.basename(oasPath),
        {
          type: 'text/plain',
          lastModified: fs.statSync(oasPath).mtimeMs
        }
      ),
      stainlessConfig: configPath ? new File(
        [fs.readFileSync(configPath)],
        path.basename(configPath),
        {
          type: 'text/plain',
          lastModified: fs.statSync(configPath).mtimeMs
        }
      ) : undefined,
      parentBuildId,
      branch,
      commitMessage,
      guessConfig
    }).asResponse();
    const buildId = build.headers.get('X-Stainless-Project-Build-ID');
    const languageHeader = build.headers.get('X-Stainless-Project-Build-Languages');
    const languages = (languageHeader?.length ? languageHeader.split(",") : []) as Stainless.Builds.OutputRetrieveParams['target'][]
    if (buildId && languages.length > 0) {
      console.log(`Created build with ID ${buildId} for languages: ${languages.join(", ")}`);
    } else {
      if (!buildId) {
        console.error("Missing build ID. Something went wrong.");
      }
      if (languages.length === 0) {
        console.error("No languages returned for this build. Something went wrong.");
      }
      process.exit(1);
    }

    let parentOutcomes: Record<string, Stainless.Builds.Outputs.CommitBuildStep.Completed['completed']> = {};
    let outcomes: Record<string, Stainless.Builds.Outputs.CommitBuildStep.Completed['completed']> = {};

    const pollingStart = Date.now();
    while (Object.keys(outcomes).length < languages.length && Date.now() - pollingStart < MAX_POLLING_SECONDS * 1000) {
      for (const language of languages) {
        if (!(language in parentOutcomes) && parentBuildId) {
          const parentBuildOutput = await stainless.builds.outputs.retrieve(parentBuildId, {target: language});
          if (parentBuildOutput.commit.status === 'completed') {
            const parentOutcome = parentBuildOutput.commit.completed;
            console.log("Parent build completed with outcome:", JSON.stringify(parentOutcome));
            parentOutcomes[language] = parentOutcome;
          } else {
            console.log(`Parent build has status ${parentBuildOutput.commit.status} for ${language}`);
          }
        }

        if (!(language in outcomes)) {
          const buildOutput = await stainless.builds.outputs.retrieve(buildId, {target: language});
          if (buildOutput.commit.status === 'completed') {
            const outcome = buildOutput.commit.completed;
            console.log("Build completed with outcome:", JSON.stringify(outcome));
            outcomes[language] = outcome;
          } else {
            console.log(`Build has status ${buildOutput.commit.status} for ${language}`);
          }
        }
      }

      // wait a bit before polling again
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    const languagesWithoutOutcome = languages.filter(language => !(language in outcomes));
    for (const language of languagesWithoutOutcome) {
      outcomes[language] = {
        conclusion: 'timed_out',
      };
    }

    // Save results to a file for the workflow to use
    fs.writeFileSync('build_sdk_results.json', JSON.stringify({
      outcomes,
      parentOutcomes,
    }, null, 2));
  } catch (error) {
    console.error("Error interacting with API:", error);
    process.exit(1); // Fail the script if there's an error
  }
}

main();