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
export declare class RunDiff {
    octokit: Octokit & Api & {
        paginate: PaginateInterface;
    };
    context: Context;
    inputs: ActionInputs;
    /**
     * Initialize clients and member variables.
     */
    constructor();
    /**
     * Main execution method. Gets the job ID, runs the CDKTF diff, and processes the results.
     * Sets action outputs and writes results to a file. Fails the action if errors are detected.
     */
    run(): Promise<void>;
    /**
     * Retrieves the job ID and HTML URL for the current workflow job.
     *
     * @returns Promise containing the job ID and HTML URL
     * @throws Error if the job cannot be found
     */
    getJobInformation(): Promise<{
        job_id: number;
        html_url: string;
    }>;
    /**
     * Executes the CDKTF diff command and processes its output.
     * Supports both real execution and test mode with stub output.
     *
     * @returns Promise containing result code and summary
     * @throws Error if the diff execution fails unexpectedly
     */
    runDiff(): Promise<{
        result_code: ActionOutputs["result_code"];
        summary: string;
    }>;
    /**
     * Parses the output from CDKTF diff command and determines the result.
     *
     * @param output - Raw output from the diff command
     * @returns Object containing result code and summary
     * @throws Error if the output cannot be parsed
     */
    private parseOutput;
}
export {};
