import { getInputs, run } from "../src";
import * as core from "@actions/core";
import * as github from "@actions/github";
import * as exec from "@actions/exec";
import * as fs from "fs";

jest.mock("@actions/core");
jest.mock("@actions/github");
jest.mock("@actions/exec");
jest.mock("fs");

describe("CDKTF Diff Action", () => {
  const mockInputs = {
    githubToken: "mock-token",
    jobName: "test-job",
    outputFilename: "output.json",
    ref: "main",
    stack: "test-stack",
    terraformVersion: "1.8.0",
    workingDirectory: "./",
    skipSynth: false
  };

  beforeEach(() => {
    jest.resetAllMocks();
    (core.getInput as jest.Mock).mockImplementation((name) => {
      switch (name) {
        case "github_token": return mockInputs.githubToken;
        case "job_name": return mockInputs.jobName;
        case "output_filename": return mockInputs.outputFilename;
        case "ref": return mockInputs.ref;
        case "stack": return mockInputs.stack;
        case "terraform_version": return mockInputs.terraformVersion;
        case "working_directory": return mockInputs.workingDirectory;
        case "skip_synth": return mockInputs.skipSynth.toString();
        default: return "";
      }
    });
  });

  describe("getInputs", () => {
    it("should return correct inputs", async () => {
      const inputs = await getInputs();
      expect(inputs).toEqual(mockInputs);
    });

    it("should use default values when not provided", async () => {
      (core.getInput as jest.Mock).mockImplementation((name) => {
        if (["github_token", "job_name", "output_filename", "ref", "stack"].includes(name)) {
          return "mock-value";
        }
        return "";
      });

      const inputs = await getInputs();
      expect(inputs.terraformVersion).toBe("1.8.0");
      expect(inputs.workingDirectory).toBe("./");
      expect(inputs.skipSynth).toBe(false);
    });
  });

  describe("run", () => {
    beforeEach(() => {
      const mockOctokit = {
        rest: {
          actions: {
            listJobsForWorkflowRun: jest.fn().mockResolvedValue({
              data: {
                jobs: [{
                  id: 123,
                  name: "test-job",
                  html_url: "https://github.com/test/url"
                }]
              }
            })
          }
        }
      };
      (github.getOctokit as jest.Mock).mockReturnValue(mockOctokit);
    });

    it("should handle successful run with no changes", async () => {
      (exec.exec as jest.Mock).mockImplementation((cmd, args, opts) => {
        opts.listeners.stdout("No changes. Your infrastructure matches the configuration.");
        return Promise.resolve(0);
      });

      await run();

      expect(core.setOutput).toHaveBeenCalledWith("resultCode", "0");
      expect(core.setOutput).toHaveBeenCalledWith("summary", "No changes. Your infrastructure matches the configuration.");
    });

    it("should handle successful run with changes", async () => {
      (exec.exec as jest.Mock).mockImplementation((cmd, args, opts) => {
        opts.listeners.stdout("Plan: 2 to add, 1 to change, 1 to destroy.");
        return Promise.resolve(0);
      });

      await run();

      expect(core.setOutput).toHaveBeenCalledWith("resultCode", "2");
      expect(core.setOutput).toHaveBeenCalledWith("summary", "Plan: 2 to add, 1 to change, 1 to destroy.");
    });

    it("should handle failed run", async () => {
      (exec.exec as jest.Mock).mockImplementation((cmd, args, opts) => {
        opts.listeners.stderr("Planning failed. Terraform encountered an error\nError: Invalid configuration");
        return Promise.reject(new Error("Command failed"));
      });

      await run();

      expect(core.setOutput).toHaveBeenCalledWith("resultCode", "1");
      expect(core.setOutput).toHaveBeenCalledWith("summary", "Error: Invalid configuration");
    });
  });

  describe("getJobId", () => {
    it("should handle pagination when job is on second page", async () => {
      const mockOctokit = {
        rest: {
          actions: {
            listJobsForWorkflowRun: jest.fn()
              .mockResolvedValueOnce({
                data: {
                  jobs: Array(100).fill({ id: 1, name: "other-job" })
                }
              })
              .mockResolvedValueOnce({
                data: {
                  jobs: [{ id: 123, name: "test-job", html_url: "https://github.com/test/url" }]
                }
              })
          }
        }
      };
      (github.getOctokit as jest.Mock).mockReturnValue(mockOctokit);

      await run();
      expect(mockOctokit.rest.actions.listJobsForWorkflowRun).toHaveBeenCalledTimes(2);
    });

    it("should throw error when job is not found", async () => {
      const mockOctokit = {
        rest: {
          actions: {
            listJobsForWorkflowRun: jest.fn().mockResolvedValue({
              data: {
                jobs: [{ id: 123, name: "wrong-job" }]
              }
            })
          }
        }
      };
      (github.getOctokit as jest.Mock).mockReturnValue(mockOctokit);

      await expect(run()).rejects.toThrow("Could not find job with name test-job");
    });
  });

  describe("runDiff", () => {
    it("should handle stub output file", async () => {
      (core.getInput as jest.Mock).mockImplementation((name) => {
        if (name === "stub_output_file") return "test.txt";
        return mockInputs[name] || "";
      });
      
      (fs.readFileSync as jest.Mock).mockReturnValue("Plan: 1 to add");
      
      await run();
      
      expect(core.setOutput).toHaveBeenCalledWith("resultCode", "2");
      expect(core.setOutput).toHaveBeenCalledWith("summary", "Plan: 1 to add");
    });

    it("should add skip-synth flag when enabled", async () => {
      (core.getInput as jest.Mock).mockImplementation((name) => {
        if (name === "skip_synth") return "true";
        return mockInputs[name] || "";
      });
      
      let executedCommand = "";
      (exec.exec as jest.Mock).mockImplementation((cmd) => {
        executedCommand = cmd;
        return Promise.resolve(0);
      });
      
      await run();
      
      expect(executedCommand).toContain("--skip-synth");
    });

    it("should handle unrecognized output", async () => {
      (exec.exec as jest.Mock).mockImplementation((cmd, args, opts) => {
        opts.listeners.stdout("Some unexpected output");
        return Promise.resolve(0);
      });

      await run();

      expect(core.setOutput).toHaveBeenCalledWith("resultCode", "1");
      expect(core.setOutput).toHaveBeenCalledWith("summary", "Could not determine if diff ran successfully");
    });
  });
});
