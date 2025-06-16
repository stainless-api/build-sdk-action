import * as github from "@actions/github";
import { Outcomes } from "./build";
import { BuildTarget } from "stainless/resources/index";

export function generatePreviewComment({
  outcomes,
  baseOutcomes,
  orgName,
  projectName,
}: {
  outcomes: Outcomes;
  baseOutcomes?: Outcomes | null;
  orgName: string;
  projectName: string;
}) {
  const generateRow = (
    lang: string,
    outcome: Outcomes[string],
    baseOutcome?: Outcomes[string],
  ) => {
    const studioUrl = `https://app.stainless.com/${orgName}/${projectName}/studio?language=${lang}&branch=preview/${github.context.payload.pull_request!.head.ref}`;
    let githubUrl;
    let compareUrl;
    let notes = "";

    const baseCompletedCommit = baseOutcome?.commit.completed;
    const completedCommit = outcome.commit.completed;

    if (completedCommit.commit) {
      const { owner, name, branch } = completedCommit.commit.repo;
      githubUrl = `https://github.com/${owner}/${name}/tree/${branch}`;

      if (baseCompletedCommit?.commit) {
        const base = baseCompletedCommit.commit.repo.branch;
        const head = branch;
        compareUrl = `https://github.com/${owner}/${name}/compare/${base}..${head}`;
      } else {
        if (baseOutcome) {
          notes = `Could not generate a diff link because the base build had conclusion: ${baseCompletedCommit?.conclusion}`;
        } else {
          notes = `Could not generate a diff link because a base build was not found`;
        }
      }
    } else if (completedCommit.merge_conflict_pr) {
      const {
        number,
        repo: { owner, name },
      } = completedCommit.merge_conflict_pr;
      const mergeConflictUrl = `https://github.com/${owner}/${name}/pull/${number}`;
      const runUrl = `https://github.com/${github.context.payload.repository?.full_name}/actions/runs/${github.context.runId}`;
      if (completedCommit.conclusion === "upstream_merge_conflict") {
        notes = `A preview could not be generated because there is a conflict on the parent branch. Please resolve the [conflict](${mergeConflictUrl}) then re-run the [workflow](${runUrl}).`;
      } else {
        notes = `The build resulted in a merge conflict. Please resolve the [conflict](${mergeConflictUrl}) then re-run the [workflow](${runUrl}).`;
      }
    } else {
      notes = `Could not generate a branch or diff link because the build had conclusion: ${completedCommit.conclusion}`;
    }

    const githubLink = githubUrl ? `[Branch](${githubUrl})` : "";
    const studioLink = studioUrl ? `[Studio](${studioUrl})` : "";
    const compareLink = compareUrl ? `[Diff](${compareUrl})` : "";
    let ci;
    const steps = ['lint', 'test', 'upload', 'build'] as const
    if (steps.some(
      (key) => outcome[key]?.status !== "completed",
    )) {
      ci = "pending";
    } else if (steps.every(
      (key) => !outcome[key] || (outcome[key] as BuildTarget.Completed).completed.conclusion === "success",
    )) {
      ci = "success";
    } else {
      ci = "error";
    }

    return `
| ${lang} | ${completedCommit.conclusion} | ${githubLink} | ${studioLink} | ${compareLink} | ${notes} |`;
  };

  const header = `
| Language | Conclusion | CI | Branch | Studio | Diff | Notes |
|----------|------------|----|--------|--------|------|-------|`;

  const tableRows = Object.keys(outcomes)
    .map((lang) => {
      return generateRow(lang, outcomes[lang], baseOutcomes?.[lang]);
    })
    .join("");

  const npmCommit = (outcomes["typescript"] ?? outcomes["node"])?.commit.completed.commit;
  const npmPkgInstallCommand = npmCommit ?
    `# ${outcomes["typescript"] ? "typescript" : "node"}
npm install "https://pkg.stainless.com/s/${npmCommit.repo.name}/${npmCommit.sha}"`
    : "";
    const npmGitHubInstallCommand = npmCommit
  ? `# ${outcomes["typescript"] ? "typescript" : "node"}
npm install "https://github.com/${npmCommit.repo.owner}/${npmCommit.repo.name}.git#${npmCommit.repo.branch}"`
  : "";

  const pythonCommit = outcomes["python"]?.commit.completed.commit;
  const pythonPkgInstallCommand = pythonCommit
    ? `# python
pip install https://pkg.stainless.com/s/${pythonCommit.repo.name}/${pythonCommit.sha}`
    : "";
  const pythonGitHubInstallCommand = pythonCommit
  ? `# python
pip install git+https://github.com/${pythonCommit.repo.owner}/${pythonCommit.repo.name}.git@${pythonCommit.repo.branch}`
  : "";

  const npmBuild = (outcomes["typescript"] ?? outcomes["node"]).build;
  const npmInstallCommand = npmBuild?.status === "completed" && npmBuild.completed.conclusion === "success" ? npmPkgInstallCommand : npmGitHubInstallCommand;

  const pythonUpload = outcomes["python"]?.upload;
  const pythonInstallCommand = pythonUpload?.status === "completed" && pythonUpload.completed.conclusion === "success"
    ? pythonPkgInstallCommand
    : pythonGitHubInstallCommand;

  const installation =
    npmInstallCommand || pythonInstallCommand
      ? `#### :package: Installation
${[npmInstallCommand, pythonInstallCommand]
  .filter(Boolean)
  .map((cmd) => `\`\`\`bash\n${cmd}\n\`\`\``)
  .join("\n")}`
      : "";

  return `
### :sparkles: SDK Previews
_Last updated: ${new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC")}_

The following table summarizes the build outcomes for all languages:

${header}${tableRows}

You can freely modify the branches to add [custom code](https://app.stainlessapi.com/docs/guides/patch-custom-code).${installation ? `\n${installation}` : ""}
    `;
}

export function generateMergeComment({
  outcomes,
  orgName,
  projectName,
}: {
  outcomes: Outcomes;
  orgName: string;
  projectName: string;
}) {
  const generateRow = (
    lang: string,
    outcome: NonNullable<typeof outcomes>[string],
  ) => {
    let studioUrl;

    if (outcome.commit) {
      studioUrl = `https://app.stainless.com/${orgName}/${projectName}/studio?language=${lang}&branch=main`;
    }

    const studioLink = studioUrl ? `[Studio](${studioUrl})` : "";

    return `
| ${lang} | ${outcome.commit.completed.conclusion} | ${studioLink} |`;
  };

  const header = `
| Language | Conclusion | Studio |
|----------|------------|--------|`;

  const tableRows = Object.keys(outcomes)
    .map((lang) => {
      const outcome = outcomes[lang];
      return generateRow(lang, outcome);
    })
    .join("");

  return `
### :rocket: SDK Build Status
The following table summarizes the build outcomes for all languages:

${header}${tableRows}
`;
}

export async function upsertComment({
  body,
  token,
}: {
  body: string;
  token: string;
}) {
  const octokit = github.getOctokit(token);

  console.log(
    "Upserting comment on PR:",
    github.context.payload.pull_request!.number,
  );

  const { data: comments } = await octokit.rest.issues.listComments({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: github.context.payload.pull_request!.number,
  });

  const firstLine = body.trim().split("\n")[0];
  const existingComment = comments.find((comment) =>
    comment.body?.includes(firstLine),
  );

  if (existingComment) {
    console.log("Updating existing comment:", existingComment.id);
    await octokit.rest.issues.updateComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      comment_id: existingComment.id,
      body,
    });
  } else {
    console.log("Creating new comment");
    await octokit.rest.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: github.context.issue.number,
      body,
    });
  }
}
