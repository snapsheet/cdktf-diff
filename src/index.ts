import * as core from "@actions/core";
import { RunDiff } from "./runDiff";

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export default async function run(): Promise<void> {
  try {
    const diffPlan = new RunDiff();
    await diffPlan.run();
  } catch (error) {
    // Fail the workflow run if an error occurs
    core.setFailed(error instanceof Error ? error.message : error);
  }
}

run();
