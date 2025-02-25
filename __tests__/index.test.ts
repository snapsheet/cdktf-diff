import * as core from "@actions/core";
import { RunDiff } from "../src/runDiff";
import run from "../src/index";

// Mock dependencies
jest.mock("@actions/core");
jest.mock("../src/runDiff", () => ({
  RunDiff: jest.fn()
}));

describe("index", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should execute RunDiff successfully", async () => {
    // Mock RunDiff implementation
    const mockRun = jest.fn();
    (RunDiff as jest.Mock).mockImplementation(() => ({
      run: mockRun
    }));

    await run();

    // Verify RunDiff was instantiated and run was called
    expect(RunDiff).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("should handle Error objects", async () => {
    // Mock RunDiff to throw an Error
    const errorMessage = "Test error";
    const mockRun = jest.fn().mockRejectedValue(new Error(errorMessage));
    (RunDiff as jest.Mock).mockImplementation(() => ({
      run: mockRun
    }));

    await run();

    // Verify error was handled correctly
    expect(core.setFailed).toHaveBeenCalledWith(errorMessage);
  });

  it("should handle non-Error objects", async () => {
    // Mock RunDiff to throw a string
    const errorString = "String error";
    const mockRun = jest.fn().mockRejectedValue(errorString);
    (RunDiff as jest.Mock).mockImplementation(() => ({
      run: mockRun
    }));

    await run();

    // Verify error was handled correctly
    expect(core.setFailed).toHaveBeenCalledWith(errorString);
  });
}); 