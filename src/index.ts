import { Stainless } from 'stainless';
import { getBooleanInput, getInput, setOutput } from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';

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
    const parentOasHash = getInput('parent_oas_hash', { required: false }) || undefined;
    const parentConfigHash = getInput('parent_config_hash', { required: false }) || undefined;
    const parentBranch = getInput('parent_branch', { required: false }) || undefined;
    const branch = getInput('branch', { required: false }) || undefined;
    const mergeBranch = getInput('merge_branch', { required: false }) || undefined;
    const commitMessage = getInput('commit_message', { required: false }) || undefined;
    const guessConfig = getBooleanInput('guess_config', { required: false });

    const stainless = new Stainless({ apiKey: stainless_api_key, logLevel: 'warn' });

    if (commitMessage && !isValidConventionalCommitMessage(commitMessage)) {        
      console.error('Invalid commit message format. Please follow the Conventional Commits format: https://www.conventionalcommits.org/en/v1.0.0/');
      process.exit(1);
    }

    let parentBuildId;

    if (parentBranch) {
      // attempt to find a parent build
      const recentBuilds = await stainless.builds.list({
          project: projectName,
          spec_hash: parentOasHash,
          config_hash: parentConfigHash,
          branch: parentBranch,
          limit: 1,
      });
      parentBuildId = recentBuilds[0]?.id || undefined;
      if (parentBuildId) {
        console.log("Found parent build:", parentBuildId);
      } else {
        console.log("No parent build found.");
      }
    }

    const oasBuffer = fs.readFileSync(oasPath);
    const configBuffer = configPath ? fs.readFileSync(configPath) : undefined;

    // create a new build
    const build = await stainless.builds.create({
      projectName,
      oasSpec: new File(
        [oasBuffer],
        path.basename(oasPath),
        {
          type: 'text/plain',
          lastModified: fs.statSync(oasPath).mtimeMs
        }
      ),
      stainlessConfig: configPath && configBuffer ? new File(
        [configBuffer],
        path.basename(configPath),
        {
          type: 'text/plain',
          lastModified: fs.statSync(configPath).mtimeMs
        }
      ) : undefined,
      parentBuildId,
      branch,
      mergeBranch,
      commitMessage,
      guessConfig
    }).asResponse();
    let buildId = build.headers.get('X-Stainless-Project-Build-ID');
    const languageHeader = build.headers.get('X-Stainless-Project-Build-Languages');
    let languages = (languageHeader?.length ? languageHeader.split(",") : []) as Stainless.Builds.OutputRetrieveParams['target'][]
    if (buildId) {
      console.log(`Created build with ID ${buildId} for languages: ${languages.join(", ")}`);
    } else {
      if (!buildId) {
        console.log(`No new build was created. Checking for existing builds with the inputs provided...`);
        const build = (await stainless.builds.list({
          project: projectName,
          spec_hash: crypto.createHash('md5').update(oasBuffer).digest('hex'),
          config_hash: configBuffer ? crypto.createHash('md5').update(configBuffer).digest('hex') : undefined,
          branch,
          limit: 1,
        }))[0];

        if (build) {
          buildId = build.id;
          languages = build.targets;
          console.log(`Found existing build with ID ${buildId} for languages: ${languages.join(", ")}`);
        }
      }

      if (!buildId) {
        console.error("No existing build was found for this branch. Presumably it does not include SDK config changes");
        process.exit(0);
      }
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

    setOutput('results', {outcomes, parentOutcomes});
  } catch (error) {
    console.error("Error interacting with API:", error);
    process.exit(1);
  }
}

main();