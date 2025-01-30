"use strict";
/**
 * CDKTF Diff Action
 *
 * This GitHub Action executes `cdktf diff` on CDK for Terraform code and provides structured output.
 * It helps automate the process of detecting and validating infrastructure changes in CI/CD pipelines.
 *
 * @packageDocumentation
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInputs = getInputs;
exports.run = run;
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const exec = __importStar(require("@actions/exec"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Retrieves and validates all inputs for the action.
 * Applies default values where appropriate.
 *
 * @returns Promise<ActionInputs> Object containing all validated inputs
 * @throws Will throw an error if required inputs are missing
 */
async function getInputs() {
    return {
        githubToken: core.getInput('github_token', { required: true }),
        jobName: core.getInput('job_name', { required: true }),
        outputFilename: core.getInput('output_filename', { required: true }),
        ref: core.getInput('ref', { required: true }),
        stack: core.getInput('stack', { required: true }),
        stubOutputFile: core.getInput('stub_output_file'),
        terraformVersion: core.getInput('terraform_version') || '1.8.0',
        workingDirectory: core.getInput('working_directory') || './',
        skipSynth: core.getInput('skip_synth') === 'true',
        artifactName: core.getInput('artifact_name')
    };
}
/**
 * Retrieves the job ID and HTML URL for the current workflow job.
 * Supports pagination when querying the GitHub API.
 *
 * @param token - GitHub token for API access
 * @param jobName - Name of the job to find
 * @returns Promise containing the job ID and HTML URL
 * @throws Error if the job cannot be found
 */
async function getJobId(token, jobName) {
    const octokit = github.getOctokit(token);
    let page = 1;
    while (true) {
        const response = await octokit.rest.actions.listJobsForWorkflowRun({
            ...github.context.repo,
            run_id: github.context.runId,
            per_page: 100,
            page
        });
        const job = response.data.jobs.find(j => j.name === jobName);
        if (job) {
            return {
                jobId: job.id.toString(),
                htmlUrl: job.html_url || ""
            };
        }
        if (response.data.jobs.length < 100) {
            throw new Error(`Could not find job with name ${jobName}`);
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
async function runDiff(inputs) {
    var _a;
    const outputPath = path.join(process.env.TMPDIR || '/tmp', 'cdktf-diff.txt');
    let diffCommand = inputs.stubOutputFile ?
        `cat ${inputs.stubOutputFile}` :
        'CI=1 npx cdktf diff';
    if (inputs.skipSynth) {
        diffCommand += ' --skip-synth';
    }
    diffCommand += ` ${inputs.stack}`;
    try {
        let output = '';
        await exec.exec(diffCommand, [], {
            listeners: {
                stdout: (data) => {
                    output += data.toString();
                },
                stderr: (data) => {
                    output += data.toString();
                }
            }
        });
        // Write output to file for parsing
        fs.writeFileSync(outputPath, output);
        const cleanOutput = output.replace(/\x1B\[([0-9]{1,3}(;[0-9]{1,2})?)?[mGK]/g, '');
        // Check for various output patterns and determine result
        if (cleanOutput.includes('Planning failed. Terraform encountered an error')) {
            const summary = ((_a = cleanOutput.match(/Error: .*/)) === null || _a === void 0 ? void 0 : _a[0]) || 'Unknown error occurred';
            return { resultCode: '1', summary };
        }
        if (cleanOutput.includes('No changes. Your infrastructure matches the configuration.')) {
            return { resultCode: '0', summary: 'No changes. Your infrastructure matches the configuration.' };
        }
        const planMatch = cleanOutput.match(/Plan:.*/);
        if (planMatch) {
            return { resultCode: '2', summary: planMatch[0] };
        }
        throw new Error('Could not determine if diff ran successfully');
    }
    catch (error) {
        return { resultCode: '1', summary: error.message };
    }
}
/**
 * Main entry point for the action.
 * Orchestrates the entire diff process and handles outputs.
 *
 * @returns Promise<void>
 * @throws Error if any critical step fails
 */
async function run() {
    try {
        // Get and validate inputs
        const inputs = await getInputs();
        // Get job information
        const { jobId, htmlUrl } = await getJobId(inputs.githubToken, inputs.jobName);
        // Run the diff
        const { resultCode, summary } = await runDiff(inputs);
        // Prepare outputs
        const outputs = {
            htmlUrl,
            jobId,
            resultCode,
            stack: inputs.stack,
            summary
        };
        // Set action outputs
        Object.entries(outputs).forEach(([key, value]) => {
            core.setOutput(key, value);
        });
        // Write outputs to file
        const outputPath = path.join(inputs.workingDirectory, inputs.outputFilename);
        fs.writeFileSync(outputPath, JSON.stringify(outputs));
    }
    catch (error) {
        core.setFailed(error.message);
    }
}
// Execute the action if this is the main module
if (require.main === module) {
    run();
}
