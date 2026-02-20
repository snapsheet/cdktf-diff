import * as github from "@actions/github";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Context } from "@actions/github/lib/context";
import { Octokit } from "@octokit/core";
import { PaginateInterface } from "@octokit/plugin-paginate-rest";
import { Api } from "@octokit/plugin-rest-endpoint-methods/dist-types/types";

/**
 * Interface representing all possible inputs for the action.
 * These inputs are defined in action.yml and can be provided when using the action.
 */
interface ActionInputs {
  /** GITHUB_TOKEN to use GitHub API. Simply specify secrets.GITHUB_TOKEN. */
  githubToken: string;
  /** jobs.<job-id>.name of this workflow job. This is needed to get the job ID via query. */
  jobName: string;
  /** Name of the file this jobs outputs will be saved into. */
  outputFilename: string;
  /** The ref (branch or sha) to use with the diff. */
  ref: string;
  /** Full name of the CDKTF stack to diff. */
  stack: string;
  /** When present, no Terraform will execute. The output of this action will be substituted with the output contained in this file. This is useful for cases when you want to test but don't have authentication set up. */
  stubOutputFile?: string;
  /** The version of Terraform to use (defaults to 1.8.0) */
  terraformVersion: string;
  /** Working directory where CDKTF code is located */
  workingDirectory: string;
  /** Skip synthesis of the application, assume the synthesized Terraform code is already present and up to date */
  skipSynth: boolean;
  /** When given, attempt to download the given artifact contents into this working directory. */
  artifactName?: string;
}

/**
 * Interface representing the structured outputs from the action.
 * These outputs can be used by subsequent steps in the workflow.
 */
interface ActionOutputs {
  /** Direct link to the job execution */
  html_url: string;
  /** ID of the executed job */
  job_id: string;
  /**
   * Result code indicating the outcome:
   * - '0': Success with no changes
   * - '1': Error occurred
   * - '2': Success with changes detected
   */
  result_code: "0" | "1" | "2";
  /** Name of the CDKTF stack used */
  stack: string;
  /** Human-readable summary of changes */
  summary: string;
}

/**
 * Executes CDKTF diff command, parses the output, and provides structured results.
 * Handles different output patterns to determine if there are changes, errors, or no changes.
 */
export class RunDiff {
  octokit: Octokit & Api & { paginate: PaginateInterface };
  context: Context;
  inputs: ActionInputs;

  /**
   * Initialize clients and member variables.
   */
  constructor() {
    // Get inputs first
    this.inputs = {
      githubToken: core.getInput("github_token", { required: true }),
      jobName: core.getInput("job_name", { required: true }),
      outputFilename: core.getInput("output_filename", { required: true }),
      ref: core.getInput("ref", { required: true }),
      stack: core.getInput("stack", { required: true }),
      stubOutputFile: core.getInput("stub_output_file"),
      terraformVersion: core.getInput("terraform_version") || "1.8.0",
      workingDirectory: core.getInput("working_directory") || "./",
      skipSynth: core.getBooleanInput("skip_synth"),
      artifactName: core.getInput("artifact_name"),
    };

    // Then create octokit with the token
    this.octokit = github.getOctokit(this.inputs.githubToken);
    this.context = github.context;
    core.debug(`Context:\n${JSON.stringify(this.context)}`);
  }

  /**
   * Main execution method. Gets the job ID, runs the CDKTF diff, and processes the results.
   * Sets action outputs and writes results to a file. Fails the action if errors are detected.
   */
  async run() {
    // Get job information
    const { job_id, html_url } = await this.getJobInformation();

    // Run the diff
    const { result_code, summary } = await this.runDiff();

    // Prepare outputs
    const outputs: ActionOutputs = {
      html_url,
      job_id: job_id.toString(),
      result_code,
      stack: this.inputs.stack,
      summary,
    };

    // Set action outputs
    Object.entries(outputs).forEach(([key, value]) => {
      core.setOutput(key, value);
    });

    // Write outputs to file
    const outputPath = path.join(
      this.inputs.workingDirectory,
      this.inputs.outputFilename,
    );
    fs.writeFileSync(outputPath, JSON.stringify(outputs));

    if (result_code === "1") {
      core.setFailed(summary);
    }
  }

  /**
   * Retrieves the job ID and HTML URL for the current workflow job.
   *
   * @returns Promise containing the job ID and HTML URL
   * @throws Error if the job cannot be found
   */
  async getJobInformation(): Promise<{ job_id: number; html_url: string }> {
    const octokitPaginatedJobs = await this.octokit.paginate(
      this.octokit.rest.actions.listJobsForWorkflowRun,
      {
        ...github.context.repo,
        run_id: github.context.runId,
      },
    );

    const job = octokitPaginatedJobs.find(
      (j) => j.name === this.inputs.jobName,
    );

    if (job) {
      return {
        job_id: job.id,
        html_url: job.html_url || "",
      };
    } else {
      throw new Error(`Could not find job with name ${this.inputs.jobName}`);
    }
  }

  /**
   * Executes the CDKTF diff command and processes its output.
   * Supports both real execution and test mode with stub output.
   *
   * @returns Promise containing result code and summary
   * @throws Error if the diff execution fails unexpectedly
   */
  async runDiff(): Promise<{
    result_code: ActionOutputs["result_code"];
    summary: string;
  }> {
    const outputPath = path.join(os.tmpdir() || "/tmp", "cdktf-diff.txt");
    const diffCommand = [
      this.inputs.stubOutputFile
        ? `cat ${this.inputs.stubOutputFile}`
        : "CI=1 npx cdktf diff",
    ];
    if (this.inputs.skipSynth) diffCommand.push("--skip-synth");
    diffCommand.push(this.inputs.stack);

    try {
      let output = "";
      const exitCode = await exec.exec("bash", ["-c", diffCommand.join(" ")], {
        ignoreReturnCode: true,
        listeners: {
          stdout: (data: Buffer) => {
            output += data.toString();
          },
          stderr: (data: Buffer) => {
            output += data.toString();
          },
        },
        cwd: this.inputs.workingDirectory,
      });

      // Write output to file for parsing
      fs.writeFileSync(outputPath, output);

      return this.parseOutput(output, exitCode);
    } catch (error) {
      return { result_code: "1", summary: (error as Error).message };
    }
  }

  /**
   * Parses the output from CDKTF diff command and determines the result.
   *
   * @param output - Raw output from the diff command
   * @param exitCode - Exit code from the diff command
   * @returns Object containing result code and summary
   * @throws Error if the output cannot be parsed
   */
  private parseOutput(
    output: string,
    exitCode: number,
  ): {
    result_code: ActionOutputs["result_code"];
    summary: string;
  } {
    // eslint-disable-next-line no-control-regex
    const cleanOutput = output.replace(
      /\x1B\[([0-9]{1,3}(;[0-9]{1,2})?)?[mGK]/g,
      "",
    );

    if (exitCode !== 0) {
      return {
        result_code: "1",
        summary: `Plan failed with exit code ${exitCode}. See run for details.`,
      };
    }

    if (
      cleanOutput.includes(
        "No changes. Your infrastructure matches the configuration.",
      )
    ) {
      return {
        result_code: "0",
        summary: "No changes. Your infrastructure matches the configuration.",
      };
    }

    if (
      cleanOutput.includes(
        "No changes. Your infrastructure matches the configuration.",
      )
    ) {
      return {
        result_code: "0",
        summary: "No changes. Your infrastructure matches the configuration.",
      };
    }

    const planMatch = cleanOutput.match(/Plan:.*/);
    if (planMatch) {
      return { result_code: "2", summary: planMatch[0] };
    }

    throw new Error("Could not determine if diff ran successfully");
  }
}
