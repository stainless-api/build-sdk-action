"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidConventionalCommitMessage = void 0;
const stainless_1 = require("stainless");
const core_1 = require("@actions/core");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = __importDefault(require("crypto"));
// https://www.conventionalcommits.org/en/v1.0.0/
const CONVENTIONAL_COMMIT_REGEX = new RegExp(/^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\(.*\))?(!?): .*$/);
const isValidConventionalCommitMessage = (message) => {
    return CONVENTIONAL_COMMIT_REGEX.test(message);
};
exports.isValidConventionalCommitMessage = isValidConventionalCommitMessage;
const MAX_POLLING_SECONDS = 10 * 60; // 10 minutes
async function main() {
    try {
        const stainless_api_key = (0, core_1.getInput)('stainless_api_key', { required: true });
        const projectName = (0, core_1.getInput)('project_name', { required: true });
        const oasPath = (0, core_1.getInput)('oas_path', { required: true });
        const configPath = (0, core_1.getInput)('config_path', { required: false }) || undefined;
        const parentOasHash = (0, core_1.getInput)('parent_oas_hash', { required: false }) || undefined;
        const parentConfigHash = (0, core_1.getInput)('parent_config_hash', { required: false }) || undefined;
        const parentBranch = (0, core_1.getInput)('parent_branch', { required: false }) || undefined;
        const branch = (0, core_1.getInput)('branch', { required: false }) || undefined;
        const mergeBranch = (0, core_1.getInput)('merge_branch', { required: false }) || undefined;
        const commitMessage = (0, core_1.getInput)('commit_message', { required: false }) || undefined;
        const guessConfig = (0, core_1.getBooleanInput)('guess_config', { required: false });
        const stainless = new stainless_1.Stainless({ apiKey: stainless_api_key, logLevel: 'warn' });
        if (commitMessage && !(0, exports.isValidConventionalCommitMessage)(commitMessage)) {
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
            }
            else {
                console.log("No parent build found.");
            }
        }
        const oasBuffer = fs.readFileSync(oasPath);
        const configBuffer = configPath ? fs.readFileSync(configPath) : undefined;
        // create a new build
        const build = await stainless.builds.create({
            projectName,
            oasSpec: new File([oasBuffer], path.basename(oasPath), {
                type: 'text/plain',
                lastModified: fs.statSync(oasPath).mtimeMs
            }),
            stainlessConfig: configPath && configBuffer ? new File([configBuffer], path.basename(configPath), {
                type: 'text/plain',
                lastModified: fs.statSync(configPath).mtimeMs
            }) : undefined,
            parentBuildId,
            branch,
            mergeBranch,
            commitMessage,
            guessConfig
        }).asResponse();
        let buildId = build.headers.get('X-Stainless-Project-Build-ID');
        const languageHeader = build.headers.get('X-Stainless-Project-Build-Languages');
        let languages = (languageHeader?.length ? languageHeader.split(",") : []);
        if (buildId) {
            console.log(`Created build with ID ${buildId} for languages: ${languages.join(", ")}`);
        }
        else {
            if (!buildId) {
                console.log(`No new build was created. Checking for existing builds with the inputs provided...`);
                const build = (await stainless.builds.list({
                    project: projectName,
                    spec_hash: crypto_1.default.createHash('md5').update(oasBuffer).digest('hex'),
                    config_hash: configBuffer ? crypto_1.default.createHash('md5').update(configBuffer).digest('hex') : undefined,
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
        let parentOutcomes = {};
        let outcomes = {};
        const pollingStart = Date.now();
        while (Object.keys(outcomes).length < languages.length && Date.now() - pollingStart < MAX_POLLING_SECONDS * 1000) {
            for (const language of languages) {
                if (!(language in parentOutcomes) && parentBuildId) {
                    const parentBuildOutput = await stainless.builds.outputs.retrieve(parentBuildId, { target: language });
                    if (parentBuildOutput.commit.status === 'completed') {
                        const parentOutcome = parentBuildOutput.commit.completed;
                        console.log("Parent build completed with outcome:", JSON.stringify(parentOutcome));
                        parentOutcomes[language] = parentOutcome;
                    }
                    else {
                        console.log(`Parent build has status ${parentBuildOutput.commit.status} for ${language}`);
                    }
                }
                if (!(language in outcomes)) {
                    const buildOutput = await stainless.builds.outputs.retrieve(buildId, { target: language });
                    if (buildOutput.commit.status === 'completed') {
                        const outcome = buildOutput.commit.completed;
                        console.log("Build completed with outcome:", JSON.stringify(outcome));
                        outcomes[language] = outcome;
                    }
                    else {
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
        (0, core_1.setOutput)('results', { outcomes, parentOutcomes });
    }
    catch (error) {
        console.error("Error interacting with API:", error);
        process.exit(1);
    }
}
main();
