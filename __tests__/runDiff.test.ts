import { RunDiff } from "../src/runDiff";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { faker } from "@faker-js/faker";
import * as exec from "@actions/exec";

// Mock all external dependencies
jest.mock("@actions/core", () => ({
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  debug: jest.fn()
}));

jest.mock("@actions/github");

// Add exec mock since we'll be testing diff output
jest.mock("@actions/exec");

describe("RunDiff", () => {
  const mockInputs = {
    github_token: "mock-token",
    job_name: "target-job",
    output_filename: "output.json",
    ref: "main",
    stack: "test-stack",
    terraform_version: "1.8.0",
    working_directory: "./",
    skip_synth: "false"
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup core.getInput mock
    (core.getInput as jest.Mock).mockImplementation((name: string) => 
      mockInputs[name as keyof typeof mockInputs]
    );
    (core.getBooleanInput as jest.Mock).mockImplementation((name: string) => 
      mockInputs[name as keyof typeof mockInputs] === "true"
    );

    // Setup github.context
    (github.context as unknown) = {
      repo: { owner: "test-owner", repo: "test-repo" },
      runId: 12345
    };
  });

  describe("getJobId", () => {
    it("should find job ID on third page of results", async () => {
      // Create mock responses for three pages
      const page1 = {
        data: {
          jobs: Array(100).fill(null).map(() => ({
            id: faker.number.int({ min: 1000, max: 9999 }),
            name: "other-job",
            html_url: faker.internet.url(),
            status: "completed",
            conclusion: "success",
            started_at: faker.date.recent().toISOString(),
            completed_at: faker.date.recent().toISOString()
          }))
        }
      };

      const page2 = {
        data: {
          jobs: Array(100).fill(null).map(() => ({
            id: faker.number.int({ min: 1000, max: 9999 }),
            name: "another-job",
            html_url: faker.internet.url(),
            status: "completed",
            conclusion: "success",
            started_at: faker.date.recent().toISOString(),
            completed_at: faker.date.recent().toISOString()
          }))
        }
      };

      const targetJob = {
        id: 12345,
        name: "target-job",
        html_url: "https://github.com/test-owner/test-repo/actions/runs/12345",
        status: "completed",
        conclusion: "success",
        started_at: faker.date.recent().toISOString(),
        completed_at: faker.date.recent().toISOString()
      };

      const page3 = {
        data: {
          jobs: [
            ...Array(50).fill(null).map(() => ({
              id: faker.number.int({ min: 1000, max: 9999 }),
              name: "different-job",
              html_url: faker.internet.url(),
              status: "completed",
              conclusion: "success",
              started_at: faker.date.recent().toISOString(),
              completed_at: faker.date.recent().toISOString()
            })),
            targetJob
          ]
        }
      };

      // Mock Octokit to return different responses based on page number
      let currentPage = 1;
      const mockListJobs = jest.fn().mockImplementation(() => {
        switch(currentPage) {
          case 1:
            currentPage++;
            return Promise.resolve(page1);
          case 2:
            currentPage++;
            return Promise.resolve(page2);
          case 3:
            return Promise.resolve(page3);
          default:
            return Promise.resolve({ data: { jobs: [] } });
        }
      });

      (github.getOctokit as jest.Mock).mockReturnValue({
        rest: {
          actions: {
            listJobsForWorkflowRun: mockListJobs
          }
        }
      });

      const runDiff = new RunDiff();
      const result = await runDiff.getJobId();

      // Verify the correct job was found
      expect(result).toEqual({
        job_id: targetJob.id,
        html_url: targetJob.html_url
      });

      // Verify pagination was handled correctly
      expect(mockListJobs).toHaveBeenCalledTimes(3);
      expect(mockListJobs).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        run_id: 12345,
        per_page: 100,
        page: 1
      });
    });

    it("should throw error when job is not found after pagination", async () => {
      // Create mock responses with jobs that don't match our target name
      const mockPage = {
        data: {
          jobs: Array(50).fill(null).map(() => ({
            id: faker.number.int({ min: 1000, max: 9999 }),
            name: "different-job",
            html_url: faker.internet.url(),
            status: "completed",
            conclusion: "success",
            started_at: faker.date.recent().toISOString(),
            completed_at: faker.date.recent().toISOString()
          }))
        }
      };

      // Mock Octokit to return a single page with no matching job
      const mockListJobs = jest.fn().mockResolvedValue(mockPage);

      (github.getOctokit as jest.Mock).mockReturnValue({
        rest: {
          actions: {
            listJobsForWorkflowRun: mockListJobs
          }
        }
      });

      const runDiff = new RunDiff();
      
      // Verify that getJobId throws with the correct error message
      await expect(runDiff.getJobId()).rejects.toThrow(
        `Could not find job with name ${mockInputs.job_name}`
      );

      // Verify that only one page was queried before giving up
      expect(mockListJobs).toHaveBeenCalledTimes(1);
      expect(mockListJobs).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        run_id: 12345,
        per_page: 100,
        page: 1
      });
    });
  });

  describe("runDiff", () => {
    it("should handle failed planning with error", async () => {
      // Mock exec to simulate failed planning
      (exec.exec as jest.Mock).mockImplementation((_cmd: string, _args: string[], opts?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        if (opts?.listeners?.stdout) {
          opts.listeners.stdout(Buffer.from(
            "Planning failed. Terraform encountered an error while generating this plan.\nError: Invalid configuration"
          ));
        }
        return Promise.resolve(1);
      });

      const runDiff = new RunDiff();
      const result = await runDiff.runDiff();

      // Verify the error is handled correctly
      expect(result).toEqual({
        result_code: "1",
        summary: "Error: Invalid configuration"
      });

      // Verify exec was called with correct command
      expect(exec.exec).toHaveBeenCalledWith(
        "bash",
        ["-c", `CI=1 npx cdktf diff ${mockInputs.stack}`],
        expect.any(Object)
      );
    });

    it("should handle no changes scenario", async () => {
      // Mock exec to simulate no changes output
      (exec.exec as jest.Mock).mockImplementation((_cmd: string, _args: string[], opts?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        if (opts?.listeners?.stdout) {
          opts.listeners.stdout(Buffer.from(
            "No changes. Your infrastructure matches the configuration."
          ));
        }
        return Promise.resolve(0);
      });

      const runDiff = new RunDiff();
      const result = await runDiff.runDiff();

      // Verify the no changes case is handled correctly
      expect(result).toEqual({
        result_code: "0",
        summary: "No changes. Your infrastructure matches the configuration."
      });

      // Verify exec was called with correct command
      expect(exec.exec).toHaveBeenCalledWith(
        "bash",
        ["-c", `CI=1 npx cdktf diff ${mockInputs.stack}`],
        expect.any(Object)
      );
    });

    it("should handle pending changes scenario", async () => {
      const planSummary = "Plan: 1 to add, 2 to change, 3 to destroy.";
      
      // Mock exec to simulate output with pending changes
      (exec.exec as jest.Mock).mockImplementation((_cmd: string, _args: string[], opts?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        if (opts?.listeners?.stdout) {
          opts.listeners.stdout(Buffer.from(planSummary));
        }
        return Promise.resolve(0);
      });

      const runDiff = new RunDiff();
      const result = await runDiff.runDiff();

      // Verify the pending changes case is handled correctly
      expect(result).toEqual({
        result_code: "2",
        summary: planSummary
      });

      // Verify exec was called with correct command
      expect(exec.exec).toHaveBeenCalledWith(
        "bash",
        ["-c", `CI=1 npx cdktf diff ${mockInputs.stack}`],
        expect.any(Object)
      );
    });

    it("should handle indeterminate diff result", async () => {
      // Mock exec to simulate unexpected output
      (exec.exec as jest.Mock).mockImplementation((_cmd: string, _args: string[], opts?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        if (opts?.listeners?.stdout) {
          opts.listeners.stdout(Buffer.from(
            "Some unexpected output that doesn't match any known patterns"
          ));
        }
        return Promise.resolve(0);
      });

      const runDiff = new RunDiff();
      const result = await runDiff.runDiff();

      // Verify the unknown error case is handled correctly
      expect(result).toEqual({
        result_code: "1",
        summary: "Could not determine if diff ran successfully"
      });

      // Verify exec was called with correct command
      expect(exec.exec).toHaveBeenCalledWith(
        "bash",
        ["-c", `CI=1 npx cdktf diff ${mockInputs.stack}`],
        expect.any(Object)
      );
    });

    it("should add skip-synth flag when input is true", async () => {
      // Set skip-synth input to true
      (core.getBooleanInput as jest.Mock).mockImplementation((name: string) => 
        name === "skip_synth" ? true : mockInputs[name as keyof typeof mockInputs] === "true"
      );

      // Mock exec to simulate no changes output
      (exec.exec as jest.Mock).mockImplementation((_cmd: string, _args: string[], opts?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        if (opts?.listeners?.stdout) {
          opts.listeners.stdout(Buffer.from("No changes"));
        }
        return Promise.resolve(0);
      });

      const runDiff = new RunDiff();
      await runDiff.runDiff();

      // Verify exec was called with skip-synth flag
      expect(exec.exec).toHaveBeenCalledWith(
        "bash",
        ["-c", `CI=1 npx cdktf diff --skip-synth ${mockInputs.stack}`],
        expect.any(Object)
      );
    });
  });

  describe("run", () => {
    it("should write output in correct format", async () => {
      // Mock successful responses
      const mockJobInfo = {
        job_id: 12345,
        html_url: "https://github.com/test-owner/test-repo/actions/runs/12345"
      };
      jest.spyOn(RunDiff.prototype, "getJobId").mockResolvedValue(mockJobInfo);

      const mockDiffResult = {
        result_code: "2" as const,
        summary: "Plan: 1 to add, 0 to change, 0 to destroy."
      };
      jest.spyOn(RunDiff.prototype, "runDiff").mockResolvedValue(mockDiffResult);

      const runDiff = new RunDiff();
      await runDiff.run();

      // Verify outputs were set correctly
      expect(core.setOutput).toHaveBeenCalledWith("job_id", mockJobInfo.job_id.toString());
      expect(core.setOutput).toHaveBeenCalledWith("html_url", mockJobInfo.html_url);
      expect(core.setOutput).toHaveBeenCalledWith("result_code", mockDiffResult.result_code);
      expect(core.setOutput).toHaveBeenCalledWith("summary", mockDiffResult.summary);
      expect(core.setOutput).toHaveBeenCalledWith("stack", mockInputs.stack);
    });
  });
}); 