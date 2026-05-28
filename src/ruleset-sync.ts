import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface Ruleset {
  name: string;
  target: string;
  enforcement: string;
  conditions: unknown;
  rules: unknown[];
  bypass_actors: unknown[];
}

interface RepoListItem {
  nameWithOwner: string;
}

// Rulesets to apply to all repositories
const RULESETS_TO_APPLY = ["Branch-Security", "Tag-Security"];

/**
 * Execute a command and return its output
 */
function exec(command: string): string {
  try {
    return execSync(command, { encoding: "utf-8" });
  } catch (error) {
    throw new Error(`Command failed: ${command}\n${error}`);
  }
}

/**
 * Extract only the relevant fields from API response for comparison
 */
function getRelevantFields(ruleset: Ruleset): Ruleset {
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    conditions: ruleset.conditions,
    rules: ruleset.rules,
    bypass_actors: ruleset.bypass_actors,
  };
}

/**
 * Normalize ruleset for consistent comparison
 */
function normalizeRuleset(ruleset: Ruleset): Ruleset {
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    conditions: ruleset.conditions,
    rules: [...ruleset.rules].sort((r1, r2) => {
      const type1 = (r1 as any).type || "";
      const type2 = (r2 as any).type || "";
      return type1.localeCompare(type2);
    }),
    bypass_actors: ruleset.bypass_actors,
  };
}

/**
 * Check if two rulesets have identical content
 */
function rulesetsEqual(a: Ruleset, b: Ruleset): boolean {
  const aStr = JSON.stringify(normalizeRuleset(a));
  const bStr = JSON.stringify(normalizeRuleset(b));
  return aStr === bStr;
}

/**
 * Fetch all repositories owned by the authenticated user
 */
function getRepositories(): RepoListItem[] {
  console.log("[INFO] Fetching repository list...");
  const output = exec(
    "gh repo list --limit 1000 --json nameWithOwner --source --no-archived",
  );

  try {
    const repos = JSON.parse(output);
    console.log(`[INFO] Found ${repos.length} repositories\n`);
    return repos;
  } catch {
    throw new Error("Failed to parse repository list");
  }
}

/**
 * Get all rulesets for a repository (list only)
 */
function listRulesets(repoPath: string): Array<{ id: number; name: string }> {
  try {
    const output = exec(`gh api repos/${repoPath}/rulesets`);
    return JSON.parse(output);
  } catch {
    return [];
  }
}

/**
 * Get detailed ruleset information
 */
function getRuleset(repoPath: string, rulesetId: number): Ruleset {
  try {
    const output = exec(`gh api repos/${repoPath}/rulesets/${rulesetId}`);
    return JSON.parse(output);
  } catch {
    throw new Error("Failed to fetch ruleset details");
  }
}

/**
 * Load ruleset definition from JSON file
 */
function loadRulesetFromFile(filename: string): Ruleset {
  const filepath = path.join(process.cwd(), filename);
  const content = fs.readFileSync(filepath, "utf-8");
  return JSON.parse(content);
}

/**
 * Delete a ruleset from a repository
 */
function deleteRuleset(repoPath: string, rulesetId: number): void {
  exec(`gh api -X DELETE repos/${repoPath}/rulesets/${rulesetId}`);
}

/**
 * Create a new ruleset in a repository
 */
function createRuleset(repoPath: string, filename: string): void {
  const filepath = path.join(process.cwd(), filename);
  exec(`gh api -X POST repos/${repoPath}/rulesets --input "${filepath}"`);
}

/**
 * Update an existing ruleset in a repository
 */
function updateRuleset(
  repoPath: string,
  rulesetId: number,
  filename: string,
): void {
  const filepath = path.join(process.cwd(), filename);
  exec(
    `gh api -X PUT repos/${repoPath}/rulesets/${rulesetId} --input "${filepath}"`,
  );
}

/**
 * Process a repository: sync rulesets and delete unwanted ones
 */
function processRepository(repoPath: string): {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  errors: string[];
} {
  const result = {
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    errors: [] as string[],
  };

  try {
    // Get list of existing rulesets
    const rulesetList = listRulesets(repoPath);

    // Process each ruleset file
    for (const rulesetName of RULESETS_TO_APPLY) {
      const filename = `${rulesetName}.json`;

      try {
        const fileRuleset = loadRulesetFromFile(filename);
        const existingRulesetMeta = rulesetList.find(
          (r) => r.name === rulesetName,
        );

        if (existingRulesetMeta) {
          // Fetch full details for comparison
          const existingRuleset = getRuleset(repoPath, existingRulesetMeta.id);
          const existingRelevant = getRelevantFields(existingRuleset);
          const fileRelevant = getRelevantFields(fileRuleset);
          if (rulesetsEqual(fileRelevant, existingRelevant)) {
            result.skipped++;
          } else {
            updateRuleset(repoPath, existingRulesetMeta.id, filename);
            result.updated++;
          }
        } else {
          createRuleset(repoPath, filename);
          result.created++;
        }
      } catch (error) {
        result.errors.push(
          `${rulesetName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Delete rulesets not in RULESETS_TO_APPLY
    for (const rulesetMeta of rulesetList) {
      if (!RULESETS_TO_APPLY.includes(rulesetMeta.name)) {
        try {
          deleteRuleset(repoPath, rulesetMeta.id);
          result.deleted++;
        } catch (error) {
          result.errors.push(
            `Failed to delete ${rulesetMeta.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch (error) {
    result.errors.push(
      `Failed to process repository: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return result;
}

/**
 * Main entry point
 */
function main(): void {
  try {
    // Check if gh is installed
    exec("gh --version");
  } catch {
    console.error("[ERROR] gh CLI is not installed");
    process.exit(1);
  }

  try {
    const repos = getRepositories();
    const stats = {
      total: repos.length,
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      withErrors: 0,
    };

    console.log("[INFO] Processing repositories...\n");

    for (const repo of repos) {
      const result = processRepository(repo.nameWithOwner);

      let status = "[SKIP]";
      if (result.errors.length > 0) {
        status = "[ERR]";
        stats.withErrors++;
      } else if (result.created + result.updated + result.deleted > 0) {
        status = "[OK]";
      }

      console.log(`${status} ${repo.nameWithOwner}`);

      if (result.errors.length > 0) {
        result.errors.forEach((err) => console.log(`       - ${err}`));
      }

      stats.created += result.created;
      stats.updated += result.updated;
      stats.deleted += result.deleted;
      stats.skipped += result.skipped;
    }

    console.log("\n[SUMMARY]");
    console.log(`Total repositories: ${stats.total}`);
    console.log(`Created: ${stats.created}`);
    console.log(`Updated: ${stats.updated}`);
    console.log(`Deleted: ${stats.deleted}`);
    console.log(`Skipped: ${stats.skipped}`);
    console.log(`Errors: ${stats.withErrors}`);
  } catch (error) {
    console.error(
      "[ERROR] Fatal error:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}

main();
