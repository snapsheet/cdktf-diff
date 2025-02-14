import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import { Octokit } from '@octokit/core';
import * as stream from 'stream';
import { promisify } from 'util';
import * as https from 'https';
import { PaginateInterface } from "@octokit/plugin-paginate-rest";
import { Api } from "@octokit/plugin-rest-endpoint-methods/dist-types/types";

export class RunDiff {
  private readonly githubToken: string;
  private readonly jobName: string;
  private readonly outputFilename: string;
  private readonly stack: string;
  private readonly stubOutputFile?: string;
  private readonly terraformVersion: string;
  private readonly workingDirectory: string;
  private readonly skipSynth: boolean;
  private readonly artifactName?: string;
  private readonly ref: string;

  octokit: Octokit & Api & { paginate: PaginateInterface };

  constructor() {
    this.githubToken = core.getInput('github_token', { required: true });
    this.jobName = core.getInput('job_name', { required: true });
    this.outputFilename = core.getInput('output_filename', { required: true });
    this.stack = core.getInput('stack', { required: true });
    this.stubOutputFile = core.getInput('stub_output_file');
    this.terraformVersion = core.getInput('terraform_version');
    this.workingDirectory = core.getInput('working_directory') || './';
    this.skipSynth = core.getBooleanInput('skip_synth');
    this.artifactName = core.getInput('artifact_name');
    this.ref = core.getInput('ref', { required: true });

    this.octokit = github.getOctokit(this.githubToken);
  }

  async run(): Promise<void> {
    const jobInfo = await this.retrieveJobId();
    await this.loadConfiguration();
    await this.installNodeDependencies();
    
    if (this.artifactName) {
      await this.downloadArtifact();
    }
    
    const diffResult = await this.runDiff();
    await this.dumpOutputs(jobInfo, diffResult);
    await this.saveOutputs();
  }

  private async retrieveJobId(): Promise<{ jobId: string; htmlUrl: string }> {
    const octokit = github.getOctokit(this.githubToken);
    let page = 1;
    
    while (true) {
      const response = await octokit.rest.actions.listJobsForWorkflowRun({
        ...github.context.repo,
        run_id: github.context.runId,
        per_page: 100,
        page
      });

      const job = response.data.jobs.find(j => j.name === this.jobName);
      if (job) {
        core.setOutput('job_id', job.id.toString());
        core.setOutput('html_url', job.html_url || '');
        return { jobId: job.id.toString(), htmlUrl: job.html_url || '' };
      }

      if (response.data.jobs.length < 100) break;
      page++;
    }

    throw new Error(`Could not find job with name ${this.jobName}`);
  }

  private async loadConfiguration(): Promise<string> {
    const nvmrcPath = path.join(this.workingDirectory, '.nvmrc');
    const nodeVersion = fs.readFileSync(nvmrcPath, 'utf8').trim();
    core.setOutput('node_version', nodeVersion);
    return nodeVersion;
  }

  private async installNodeDependencies(): Promise<void> {
    await exec.exec('npm', ['ci'], { cwd: this.workingDirectory });
  }

  private async downloadArtifact(): Promise<void> {
    if (!this.artifactName) return;

    const octokit = github.getOctokit(this.githubToken);
    
    // Get list of artifacts for this workflow run
    const artifactsResponse = await octokit.rest.actions.listWorkflowRunArtifacts({
      ...github.context.repo,
      run_id: github.context.runId,
    });

    // Find the artifact we want
    const artifact = artifactsResponse.data.artifacts.find(
      a => a.name === this.artifactName
    );

    if (!artifact) {
      throw new Error(`No artifact found with name: ${this.artifactName}`);
    }

    // Get download URL for the artifact
    const downloadResponse = await octokit.rest.actions.downloadArtifact({
      ...github.context.repo,
      artifact_id: artifact.id,
      archive_format: 'zip',
    });

    if (!downloadResponse.url) {
      throw new Error('No download URL found for artifact');
    }

    // Create the cdktf.out directory if it doesn't exist
    const outputDir = path.join(this.workingDirectory, 'cdktf.out');
    await fs.promises.mkdir(outputDir, { recursive: true });

    // Download and extract the zip file
    const zipPath = path.join(outputDir, 'artifact.zip');
    await this.downloadFile(downloadResponse.url, zipPath);

    // Extract the zip file
    const extract = require('extract-zip');
    await extract(zipPath, { dir: outputDir });

    // Clean up the zip file
    await fs.promises.unlink(zipPath);
  }

  private async downloadFile(url: string, destPath: string): Promise<void> {
    const finished = promisify(stream.finished);
    const fileStream = fs.createWriteStream(destPath);

    return new Promise((resolve, reject) => {
      https.get(url, response => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
          return;
        }

        response.pipe(fileStream);
        finished(fileStream)
          .then(() => resolve())
          .catch(reject);
      }).on('error', reject);
    });
  }

  private async runDiff(): Promise<{ resultCode: number; summary: string }> {
    let command = 'CI=1 npx cdktf diff';
    
    if (this.stubOutputFile) {
      command = `cat ${this.stubOutputFile} | perl -pe "select undef,undef,undef,.05"`;
    }

    if (this.skipSynth) {
      command += ' --skip-synth';
    }

    command += ` ${this.stack}`;

    const tempFile = path.join(process.env.TMPDIR || '/tmp', 'cdktf-diff.txt');
    let output = '';
    
    try {
      await exec.exec(command, [], {
        cwd: this.workingDirectory,
        listeners: {
          stdout: (data: Buffer) => {
            output += data.toString();
          }
        }
      });

      fs.writeFileSync(tempFile, output);
      
      // Parse the output and determine the result
      const cleanOutput = this.stripAnsiCodes(output);
      
      if (cleanOutput.includes('Planning failed. Terraform encountered an error')) {
        const summary = cleanOutput.match(/Error: .*/)?.[0] || 'Unknown error';
        return { resultCode: 1, summary };
      }

      if (cleanOutput.includes('No changes. Your infrastructure matches the configuration')) {
        return { resultCode: 0, summary: 'No changes. Your infrastructure matches the configuration' };
      }

      const planMatch = cleanOutput.match(/Plan:.*/);
      if (planMatch) {
        return { resultCode: 2, summary: planMatch[0] };
      }

      throw new Error('Could not determine if diff ran successfully');
    } catch (error) {
      return { resultCode: 1, summary: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  private stripAnsiCodes(str: string): string {
    return str.replace(/\x1B\[([0-9]{1,3}(;[0-9]{1,2})?)?[mGK]/g, '');
  }

  private async dumpOutputs(
    jobInfo: { jobId: string; htmlUrl: string },
    diffResult: { resultCode: number; summary: string }
  ): Promise<void> {
    const outputs = {
      result_code: diffResult.resultCode,
      summary: diffResult.summary,
      html_url: jobInfo.htmlUrl,
      stack: this.stack,
      job_id: jobInfo.jobId,
      node_version: await this.loadConfiguration(),
      terraform_version: this.terraformVersion
    };

    const outputPath = path.join(this.workingDirectory, this.outputFilename);
    fs.writeFileSync(outputPath, JSON.stringify(outputs));
  }

  private async saveOutputs(): Promise<void> {
    // Note: Using actions/upload-artifact in the workflow instead of the API
  }
} 