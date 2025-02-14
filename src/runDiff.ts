import * as github from "@actions/github";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as path from "path";
import * as io from "@actions/io";
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
  htmlUrl: string;
  /** ID of the executed job */
  jobId: string;
  /** 
   * Result code indicating the outcome:
   * - '0': Success with no changes
   * - '1': Error occurred
   * - '2': Success with changes detected
   */
  resultCode: "0" | "1" | "2";
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
      githubToken: core.getInput('github_token', { required: true }),
      jobName: core.getInput('job_name', { required: true }),
      outputFilename: core.getInput('output_filename', { required: true }),
      ref: core.getInput('ref', { required: true }),
      stack: core.getInput('stack', { required: true }),
      stubOutputFile: core.getInput('stub_output_file'),
      terraformVersion: core.getInput('terraform_version') || '1.8.0',
      workingDirectory: core.getInput('working_directory') || './',
      skipSynth: core.getBooleanInput('skip_synth'),
      artifactName: core.getInput('artifact_name') ? Number(core.getInput('artifact_name')) : undefined,
    };

    // Then create octokit with the token
    this.octokit = github.getOctokit(this.inputs.githubToken);
    this.context = github.context;
    core.debug("Context:");
    core.debug(JSON.stringify(this.context));
  }

  /**
   * Octokit query parameters that are used across multiple API requests.
   */
  commonQueryParams() {
    return {
      owner: this.context.payload.organization.login,
      repo: `${this.context.payload.repository?.name}`,
      per_page: 100
    };
  }

  /**
   * Runtime entrypoint. Query for the last successful ran (not reran) jobs prior to this job and
   * return the content of the outputs JSON as an output of this job. Outputs of this job will have
   * the same key/name as the strings defined in the `needs` configuration.
   */
  async run() {
    // Get job information
    const { jobId, htmlUrl } = await this.getJobId();

    // Run the diff
    const { resultCode, summary } = await this.runDiff();

    console.log(`Summary of diff: ${summary}`);

    // Prepare outputs
    const outputs: ActionOutputs = {
      htmlUrl,
      jobId: jobId.toString(),
      resultCode,
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

  } catch (error: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
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
  async getJobId(): Promise<{ jobId: number; htmlUrl: string }> {
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
          jobId: job.id,
          htmlUrl: job.html_url || ""
        };
      }

      if (response.data.jobs.length < 100) {
        throw new Error(`Could not find job with name ${this.inputs.jobName}`);
      }

      page++;
    }
  }

  /**
   * Sets up Terraform with the specified version
   * 
   * @param version - Terraform version to install
   */
  async setupTerraform(): Promise<void> {
    // Using the setup-terraform action's functionality via CLI
    await exec.exec("curl", [
      "-o", "terraform.zip",
      `https://releases.hashicorp.com/terraform/${this.inputs.terraformVersion}/terraform_${this.inputs.terraformVersion}_linux_amd64.zip`
    ]);
    await exec.exec("unzip", ["terraform.zip"]);
    await io.mv("terraform", "/usr/local/bin/terraform");
    await exec.exec("terraform", ["version"]);

    console.log(`Setting up Terraform version ${this.inputs.terraformVersion}...`);
    console.log("Terraform setup complete");
  }

  /**
   * Sets up Node.js environment and installs dependencies
   * 
   * @param workingDirectory - Directory containing package.json
   */
  async setupNodeEnvironment(): Promise<void> {
    // Read .nvmrc file to get Node version
    const nvmrcPath = path.join(this.inputs.workingDirectory, ".nvmrc");
    let nodeVersion: string;
    
    try {
      console.log(`Check working directory: ${this.inputs.workingDirectory}`);
      console.log(`ls working directory: ${await exec.exec("ls", [], { cwd: this.inputs.workingDirectory })}`);

      nodeVersion = fs.readFileSync(nvmrcPath, "utf8").trim();
    } catch (error) {
      throw new Error("Failed to read .nvmrc file. Make sure it exists in your working directory.");
    }

    // Setup Node.js with the specified version
    const setupScript = `
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
      nvm install ${nodeVersion}
      nvm use ${nodeVersion}
    `;
    
    await exec.exec("bash", ["-c", setupScript], { cwd: this.inputs.workingDirectory });

    // Install dependencies
    await exec.exec("npm", ["ci"], { cwd: this.inputs.workingDirectory });

    console.log(`Setting up Node.js environment in ${this.inputs.workingDirectory}...`);
    console.log(`Using Node.js version from .nvmrc: ${nodeVersion}`);
    console.log("Node.js environment setup complete");
  }

  /**
   * Executes the CDKTF diff command and processes its output.
   * Supports both real execution and test mode with stub output.
   * 
   * @param inputs - Validated action inputs
   * @returns Promise containing result code and summary
   * @throws Error if the diff execution fails unexpectedly
   */
  async runDiff(): Promise<{ resultCode: ActionOutputs["resultCode"]; summary: string }> {
    const outputPath = path.join(process.env.TMPDIR || "/tmp", "cdktf-diff.txt");
    let diffCommand = this.inputs.stubOutputFile ? 
      `cat ${this.inputs.stubOutputFile}` :
      "CI=1 npx cdktf diff";

    if (this.inputs.skipSynth) {
      diffCommand += " --skip-synth";
    }
    diffCommand += ` ${this.inputs.stack}`;

    console.log(`Diff command before exec: ${diffCommand}`);
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
        return { resultCode: "1", summary };
      }

      if (cleanOutput.includes("No changes. Your infrastructure matches the configuration.")) {
        return { resultCode: "0", summary: "No changes. Your infrastructure matches the configuration." };
      }

      const planMatch = cleanOutput.match(/Plan:.*/);
      if (planMatch) {
        return { resultCode: "2", summary: planMatch[0] };
      }

      throw new Error("Could not determine if diff ran successfully");
    } catch (error) {
      return { resultCode: "1", summary: (error as Error).message };
    }
  }

  /**
   * Read the outputs from the artifact directory path.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readOutputs(artifactDirectoryPath: string): any {
    const outputFilename = core.getInput("output_filename");
    const readData = fs.readFileSync(
      `${artifactDirectoryPath}/${outputFilename}`,
      {
        encoding: "utf8",
        flag: "r"
      }
    );
    core.debug(`Output File Contents: ${readData}`);
    return JSON.parse(readData);
  }
}