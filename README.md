# CDKTF Diff

Execute `cdktf diff`, parse STDOUT/STDERR output, and return outputs based on the outcomes.

## Usage

```yaml
jobs:
  run_diffs:
    name: Run diffs
    strategy:
      fail-fast: false
      matrix: 
        name: ["project-stack", "qa-stack", "prod-stack"]
    runs-on: ubuntu-latest
    steps:
      - name: "${{ matrix.name }}: Diff for my-feature-branch"
        uses: snapsheet/cdktf-diff@TEST_SRE-2249-cdktf-diff-standalone-action
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          job_name: Run diffs (${{ matrix.name }}) # Needs to match the name of the job as it will show in the run, including interpolations.
          output_filename: outputs.json
          ref: my-feature-branch
          stack: ${{ matrix.name }}
          terraform_version: ${{ inputs.terraform_version }}
          working_directory: ./cdktf
```

## Inputs

| Input | Required? | Default | Description |
| ----- | --------- | ------- | ----------- |
| `github_token` | `true` | | The GitHub token used to create an authenticated client. For most cases, set this to `${{ secrets.GITHUB_TOKEN }}` |
| `job_name` | `true` |  | `jobs.<job-id>.name` of this workflow job. This is needed to get the job ID via query. This needs to match the name of the job as it will show in the run, including interpolations. |
| `output_filename` | `true` | `"./"` | Working directory path that contains your cdktf code. |
| `ref` | `true` |  | The ref (branch or SHA) to use with the diff. |
| `stack` | `true` |  | Full name of the CDKTF stack to diff. |
| `stub_output_file` | `false` | | When present, no Terraform will execute. The output of this action will be substituted with the output contained in this file. This is useful for cases when you want to test but don't have authentication set up. |
| `terraform_version` | `false` | `1.8.0` | The version of Terraform to use |
| `working_directory` | `false` | `"./"` | Working directory path that contains your cdktf code. |

## Outputs

| Output | Description |
| ------ | ----------- |
| `html_url` | Direct link to this job, which shows the full execution output. |
| `job_id` | ID of this job. |
| `result_code` | Similar to [-detailed-exitcode](https://developer.hashicorp.com/terraform/cli/commands/plan#detailed-exitcode) behavior for Terraform, not yet supported by CDKTF. `0` = Succeeded with empty diff (no changes), `1` = Error, `2` = Succeeded with non-empty diff (changes present) |
| `stack` | Full name of the CDKTF stack used for the diff. |
| `summary` | Single string of output to summarize the results (ie, `No changes. Your infrastructure matches the configuration.`) |

## Testing

You can test how this process parses output by using `inputs.stub_output_file`. When present, Terraform processes will not be ran, and instead the given file will be used to simulate the output of running `cdktf diff`. You can generate an example file by running the following:
```
CI=1 cdktf diff > my-example-file.txt
```

Assuming this file is in the root path of your repository directory, you reference it in the config:
```yaml
jobs:
  run_diffs:
    name: Run diffs
    strategy:
      fail-fast: false
      matrix: 
        name: ["project-stack", "qa-stack", "prod-stack"]
    runs-on: ubuntu-latest
    steps:
      - name: "${{ matrix.name }}: Diff for my-feature-branch"
        uses: snapsheet/cdktf-diff@TEST_SRE-2249-cdktf-diff-standalone-action
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          job_name: Run diffs (${{ matrix.name }})
          output_filename: outputs.json
          ref: my-feature-branch
          stack: ${{ matrix.name }}
          stub_output_file: my-example-file.txt # <-- LIKE THIS
          terraform_version: ${{ inputs.terraform_version }}
          working_directory: ./cdktf
```
