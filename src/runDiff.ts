import * as github from "@actions/github";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as path from "path";
import * as fs from "fs";
import { Context } from "@actions/github/lib/context";
import { Octokit } from "@octokit/core";
import { PaginateInterface } from "@octokit/plugin-paginate-rest";
import { Api } from "@octokit/plugin-rest-endpoint-methods/dist-types/types";

/**
 * Interface representing all possible inputs for the action.
 * These inputs are defined in action.yml and can be provided when using the action.
 */
interface ActionInputs {
  /** GitHub token for API access */
  githubToken: string;
  /** Name of the workflow job */
  jobName: string;
  /** Name of the file to save results into */
  outputFilename: string;
  /** Git ref to diff against */
  ref: string;
  /** Name of the CDKTF stack to diff */
  stack: string;
  /** Optional file containing mock output for testing */
  stubOutputFile?: string;
  /** Version of Terraform to use */
  terraformVersion: string;
  /** Directory containing CDKTF code */
  workingDirectory: string;
  /** Whether to skip synthesis step */
  skipSynth: boolean;
  /** Optional artifact to download */
  artifactName?: number;
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
 * Consolidate the output of all jobs that came prior to this job and return as the output of this job.
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
      artifactName: core.getInput("artifact_name") ? Number(core.getInput("artifact_name")) : undefined,
    };

    // Then create octokit with the token
    this.octokit = github.getOctokit(this.inputs.githubToken);
    this.context = github.context;
    core.debug("Context:");
    core.debug(JSON.stringify(this.context));
  }

  /**
   * Runtime entrypoint. Query for the last successful ran (not reran) jobs prior to this job and
   * return the content of the outputs JSON as an output of this job. Outputs of this job will have
   * the same key/name as the strings defined in the `needs` configuration.
   */
  async run() {
    // Get job information
    const { job_id, html_url } = await this.getJobId();

    // Run the diff
    const { result_code, summary } = await this.runDiff();

    // Prepare outputs
    const outputs: ActionOutputs = {
      html_url,
      job_id: job_id.toString(),
      result_code,
      stack: this.inputs.stack,
      summary
    };

    // Set action outputs
    Object.entries(outputs).forEach(([key, value]) => {
      core.setOutput(key, value);
    });

    // Write outputs to file
    const outputPath = path.join(this.inputs.workingDirectory, this.inputs.outputFilename);
    fs.writeFileSync(outputPath, JSON.stringify(outputs));

    if(result_code === "1") {
      core.setFailed(summary);
    }
  }

  /**
   * Retrieves the job ID and HTML URL for the current workflow job.
   * Supports pagination when querying the GitHub API.
   * 
   * @param jobName - Name of the job to find
   * @returns Promise containing the job ID and HTML URL
   * @throws Error if the job cannot be found
   */
  async getJobId(): Promise<{ job_id: number; html_url: string }> {
    let page = 1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await this.octokit.rest.actions.listJobsForWorkflowRun({
        ...github.context.repo,
        run_id: github.context.runId,
        per_page: 100,
        page
      });

      const job = response.data.jobs.find(j => j.name === this.inputs.jobName);
      if (job) {
        return {
          job_id: job.id,
          html_url: job.html_url || ""
        };
      }

      if (response.data.jobs.length < 100) {
        throw new Error(`Could not find job with name ${this.inputs.jobName}`);
      }

      page++;
    }
  }

  /**
   * Executes the CDKTF diff command and processes its output.
   * Supports both real execution and test mode with stub output.
   * 
   * @param inputs - Validated action inputs
   * @returns Promise containing result code and summary
   * @throws Error if the diff execution fails unexpectedly
   */
  async runDiff(): Promise<{ result_code: ActionOutputs["result_code"]; summary: string }> {
    const outputPath = path.join(process.env.TMPDIR || "/tmp", "cdktf-diff.txt");
    let diffCommand = this.inputs.stubOutputFile ? 
      `cat ${this.inputs.stubOutputFile}` :
      "CI=1 npx cdktf diff";

    if (this.inputs.skipSynth) {
      diffCommand += " --skip-synth";
    }
    diffCommand += ` ${this.inputs.stack}`;

    try {
      let output = "";
      await exec.exec("bash", ["-c", diffCommand], {
        listeners: {
          stdout: (data: Buffer) => {
            output += data.toString();
          },
          stderr: (data: Buffer) => {
            output += data.toString();
          }
        },
        cwd: this.inputs.workingDirectory
      });

      // Write output to file for parsing
      fs.writeFileSync(outputPath, output);
      // eslint-disable-next-line no-control-regex
      const cleanOutput = output.replace(/\x1B\[([0-9]{1,3}(;[0-9]{1,2})?)?[mGK]/g, "");

      // Check for various output patterns and determine result
      if (cleanOutput.includes("Planning failed. Terraform encountered an error")) {
        const summary = cleanOutput.match(/Error: .*/)?.[0] || "Unknown error occurred";
        return { result_code: "1", summary };
      }

      if (cleanOutput.includes("No changes. Your infrastructure matches the configuration.")) {
        return { result_code: "0", summary: "No changes. Your infrastructure matches the configuration." };
      }

      const planMatch = cleanOutput.match(/Plan:.*/);
      if (planMatch) {
        return { result_code: "2", summary: planMatch[0] };
      }

      throw new Error("Could not determine if diff ran successfully");
    } catch (error) {
      return { result_code: "1", summary: (error as Error).message };
    }
  }

}
