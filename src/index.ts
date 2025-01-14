import { Stainless } from 'stainless';
import { getBooleanInput, getInput } from '@actions/core';
import * as fs from 'fs';

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
      oasSpec: fs.createReadStream(oasPath),
      stainlessConfig: configPath ? fs.createReadStream(configPath) : undefined,
      parentBuildId,
      branch,
      commitMessage,
      guessConfig
    }).asResponse();
    const buildId = build.headers.get('X-Stainless-Project-Build-ID');
    if (buildId) {
      console.log("Created build:", buildId);
    } else {
      console.error("Missing build ID. Something went wrong.");
      process.exit(1);
    }

    let parentCommit: Stainless.Builds.Outputs.CommitBuildStep.Completed.Completed.Commit | undefined;
    let commit: Stainless.Builds.Outputs.CommitBuildStep.Completed.Completed.Commit | undefined;

    const pollingStart = Date.now();
    while (Date.now() - pollingStart < MAX_POLLING_SECONDS * 1000) {
      const buildOutput = await stainless.builds.outputs.retrieve({id: buildId, target: 'node'});

      if (!parentCommit && parentBuildId) {
        const parentBuildOutput = await stainless.builds.outputs.retrieve({id: parentBuildId, target: 'node'});
        if (parentBuildOutput.commit.status === 'completed') {
          parentCommit = parentBuildOutput.commit.completed.commit;
          console.log("Parent build completed with commit:", parentCommit);
        } else {
          console.log("Parent build has status:", parentBuildOutput.commit.status);
        }
      }
      if (buildOutput.commit.status === 'completed') {
        commit = buildOutput.commit.completed.commit;
        console.log("Build completed with commit:", commit);
        break;
      } else {
        console.log("Build has status:", buildOutput.commit.status);
      }

      // wait a bit before polling again
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    if (!commit) {
      console.error("Timed out waiting for build to complete.");
      process.exit(1);
    }

    // Save results to a file for the workflow to use
    fs.writeFileSync('build_sdk_results.json', JSON.stringify({
      commit,
      parentCommit,
    }, null, 2));
  } catch (error) {
    console.error("Error interacting with API:", error);
    process.exit(1); // Fail the script if there's an error
  }
}

main();