import { execSync } from "child_process";

interface RepoListItem {
  nameWithOwner: string;
}

function main(): void {
  try {
    const output = execSync(
      "gh repo list --limit 1000 --json nameWithOwner --source --no-archived",
      { encoding: "utf-8" },
    );

    const repos: RepoListItem[] = JSON.parse(output);
    repos.forEach((repo) => console.log(repo.nameWithOwner));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
