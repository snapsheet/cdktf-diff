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
     * Runtime entrypoint. Query for the last successful ran (not reran) jobs prior to this job and
     * return the content of the outputs JSON as an output of this job. Outputs of this job will have
     * the same key/name as the strings defined in the `needs` configuration.
     */
    run(): Promise<void>;
    /**
     * Retrieves the job ID and HTML URL for the current workflow job.
     * Supports pagination when querying the GitHub API.
     *
     * @param jobName - Name of the job to find
     * @returns Promise containing the job ID and HTML URL
     * @throws Error if the job cannot be found
     */
    getJobId(): Promise<{
        job_id: number;
        html_url: string;
    }>;
    /**
     * Executes the CDKTF diff command and processes its output.
     * Supports both real execution and test mode with stub output.
     *
     * @param inputs - Validated action inputs
     * @returns Promise containing result code and summary
     * @throws Error if the diff execution fails unexpectedly
     */
    runDiff(): Promise<{
        result_code: ActionOutputs["result_code"];
        summary: string;
    }>;
}
export {};
