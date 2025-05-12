import * as exec from "@actions/exec";

export async function isConfigChanged({
  before,
  after,
  oasPath,
  configPath,
}: {
  before: string;
  after: string;
  oasPath?: string;
  configPath?: string;
}): Promise<boolean> {
  const diffOutput = await exec.getExecOutput("git", [
    "diff",
    "--name-only",
    before,
    after,
  ]);
  const changedFiles = diffOutput.stdout.trim().split("\n");

  let changed = false;

  if (oasPath && changedFiles.includes(oasPath)) {
    console.log("OAS file changed");
    changed = true;
  }

  if (configPath && changedFiles.includes(configPath)) {
    console.log("Config file changed");
    changed = true;
  }

  return changed;
}
