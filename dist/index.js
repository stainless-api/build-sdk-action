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
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidConventionalCommitMessage = void 0;
const stainless_1 = require("stainless");
const core_1 = require("@actions/core");
const fs = __importStar(require("fs"));
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
        const oldOasHash = (0, core_1.getInput)('old_oas_hash', { required: false }) || undefined;
        const oldConfigHash = (0, core_1.getInput)('old_config_hash', { required: false }) || undefined;
        const branch = (0, core_1.getInput)('branch', { required: false }) || undefined;
        const commitMessage = (0, core_1.getInput)('commit_message', { required: false }) || undefined;
        const guessConfig = (0, core_1.getBooleanInput)('guess_config', { required: false });
        const stainless = new stainless_1.Stainless({ apiKey: stainless_api_key });
        if (commitMessage && !(0, exports.isValidConventionalCommitMessage)(commitMessage)) {
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
        }
        else {
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
        }
        else {
            console.error("Missing build ID. Something went wrong.");
            process.exit(1);
        }
        let parentCommit;
        let commit;
        const pollingStart = Date.now();
        while (Date.now() - pollingStart < MAX_POLLING_SECONDS * 1000) {
            const buildOutput = await stainless.builds.outputs.retrieve({ id: buildId, target: 'node' });
            if (!parentCommit && parentBuildId) {
                const parentBuildOutput = await stainless.builds.outputs.retrieve({ id: parentBuildId, target: 'node' });
                if (parentBuildOutput.commit.status === 'completed') {
                    parentCommit = parentBuildOutput.commit.completed.commit;
                    console.log("Parent build completed with commit:", parentCommit);
                }
                else {
                    console.log("Parent build has status:", parentBuildOutput.commit.status);
                }
            }
            if (buildOutput.commit.status === 'completed') {
                commit = buildOutput.commit.completed.commit;
                console.log("Build completed with commit:", commit);
                break;
            }
            else {
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
    }
    catch (error) {
        console.error("Error interacting with API:", error);
        process.exit(1); // Fail the script if there's an error
    }
}
main();