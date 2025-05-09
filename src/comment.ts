import { getInput } from "@actions/core";
import * as github from "@actions/github";
import { Outcomes } from "./build";

export function generatePreviewComment({
  outcomes,
  parentOutcomes,
  orgName,
  projectName,
}: {
  outcomes: Outcomes;
  parentOutcomes?: Outcomes;
  orgName: string;
  projectName: string;
}) {
  const generateRow = (
    lang: string,
    outcome: Outcomes[string],
    parentOutcome?: Outcomes[string],
  ) => {
    const studioUrl = `https://app.stainless.com/${orgName}/${projectName}/studio?language=${lang}&branch=preview/${github.context.payload.pull_request!.head.ref}`;
    let githubUrl;
    let compareUrl;
    let notes = "";

    if (outcome.commit) {
      const { owner, name, branch } = outcome.commit.repo;
      githubUrl = `https://github.com/${owner}/${name}/tree/${branch}`;

      if (parentOutcome?.commit) {
        const base = parentOutcome.commit.sha;
        const head = branch;
        compareUrl = `https://github.com/${owner}/${name}/compare/${base}..${head}`;
      } else {
        if (parentOutcome) {
          notes = `Could not generate a diff link because the build's parent had conclusion: ${parentOutcome?.conclusion}`;
        } else {
          notes = `Could not generate a diff link because a parent build was not found`;
        }
      }
    } else if (outcome.merge_conflict_pr) {
      const {
        number,
        repo: { owner, name },
      } = outcome.merge_conflict_pr;
      const mergeConflictUrl = `https://github.com/${owner}/${name}/pull/${number}`;
      const runUrl = `https://github.com/${github.context.payload.repository?.full_name}/actions/runs/${github.context.runId}`;
      if (outcome.conclusion === "upstream_merge_conflict") {
        notes = `A preview could not be generated because there is a conflict on the parent branch. Please resolve the [conflict](${mergeConflictUrl}) then re-run the [workflow](${runUrl}).`;
      } else {
        notes = `The build resulted in a merge conflict. Please resolve the [conflict](${mergeConflictUrl}) then re-run the [workflow](${runUrl}).`;
      }
    } else {
      notes = `Could not generate a branch or diff link because the build had conclusion: ${outcome.conclusion}`;
    }

    const githubLink = githubUrl ? `[Branch](${githubUrl})` : "";
    const studioLink = studioUrl ? `[Studio](${studioUrl})` : "";
    const compareLink = compareUrl ? `[Diff](${compareUrl})` : "";

    return `
| ${lang} | ${outcome.conclusion} | ${githubLink} | ${studioLink} | ${compareLink} | ${notes} |`;
  };

  const header = `
| Language | Conclusion | Branch | Studio | Diff | Notes |
|----------|------------|--------|--------|------|-------|`;

  const tableRows = Object.keys(outcomes)
    .map((lang) => {
      return generateRow(lang, outcomes[lang], parentOutcomes?.[lang]);
    })
    .join("");

  const npmRepo = (outcomes["typescript"] ?? outcomes["node"])?.commit?.repo;
  const npmInstallCommand = npmRepo
    ? `# ${outcomes["typescript"] ? "typescript" : "node"}
npm install "https://github.com/${npmRepo.owner}/${npmRepo.name}.git#${npmRepo.branch}"`
    : "";

  const pythonRepo = outcomes["python"]?.commit?.repo;
  const pythonInstallCommand = pythonRepo
    ? `# python
pip install git+https://github.com/${pythonRepo.owner}/${pythonRepo.name}.git@${pythonRepo.branch}`
    : "";

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
| ${lang} | ${outcome.conclusion} | ${studioLink} |`;
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

export async function upsertComment({ body }: { body: string }) {
  const token = getInput("github-token", { required: true });
  const octokit = github.getOctokit(token);

  const { data: comments } = await octokit.rest.issues.listComments({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: github.context.payload.pull_request!.number,
  });

  const firstLine = body.trim().split("\n")[0];
  const previewComment = comments.find((comment) =>
    comment.body?.includes(firstLine),
  );

  if (previewComment) {
    await octokit.rest.issues.deleteComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      comment_id: previewComment.id,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: github.context.issue.number,
      body,
    });
  }
}
