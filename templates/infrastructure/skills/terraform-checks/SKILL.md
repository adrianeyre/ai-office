---
name: terraform-checks
description: How an Infrastructure Floor checks Terraform with no credentials and no state (format, validation, the plan and policy checks), how to read a plan, and why nothing here applies one. Use it when the checks fail, are missing, or need changing.
---

# The infrastructure's checks

An Infrastructure Floor checks every change with Terraform's own commands and checkov, at the top of the repository, run by the Floor's check command:

```sh
terraform fmt -check -recursive && terraform init -input=false -backend=false && terraform validate && terraform plan -input=false -lock=false -refresh=false && checkov --directory . --quiet
```

| Command | What it checks |
| --- | --- |
| `terraform fmt -check -recursive` | every file is formatted as Terraform formats it; `terraform fmt -recursive` formats them |
| `terraform init -input=false -backend=false` | installs the providers and modules `.terraform.lock.hcl` pins, without the remote state |
| `terraform validate` | the configuration is valid: its names, arguments and references |
| `terraform plan -input=false -lock=false -refresh=false` | plans the whole configuration from no state, without reading what is deployed, so every resource shows as one to add |
| `checkov --directory . --quiet` | checkov's own policies, and the repository's, on every resource |

## Never an apply

Nothing on this Floor changes live infrastructure. No sandbox holds cloud credentials or the remote state, and no command here applies, imports, moves state or destroys. A merged change is applied by the Owner's own pipeline, which holds the credentials and the state. When an issue needs any of that, it is for the Owner.

## Planning with no credentials and no state

- **State.** The root module has no `backend` block in the repository; the Owner's pipeline writes one before `terraform init`. With no state, the plan shows every resource as one to add.
- **Providers.** Each one plans from stand-in settings when it has no credentials. For AWS, for example:

  ```hcl
  provider "aws" {
    region                      = var.region
    skip_credentials_validation = var.offline
    skip_requesting_account_id  = var.offline
    skip_metadata_api_check     = var.offline
  }
  ```

  with `offline` true by default, and set to false by the Owner's pipeline (`TF_VAR_offline=false`). A provider that cannot plan at all without credentials is one plan QA says so of.
- **Data sources** that read the cloud become variables with stand-in defaults, which the Owner's pipeline sets.

## Reading a plan

`terraform plan -input=false -lock=false -refresh=false -out=ci.tfplan`, then `terraform show ci.tfplan`, shows what would happen to each resource: `+` add, `~` change, `-/+` replace, `-` destroy. Look at every replace and destroy, and above all for a resource that holds data among them. Delete `ci.tfplan` afterwards: a plan file can hold secrets, so it is never committed.

## Policy checks

checkov runs its own policies on every resource, and the repository's own in `policies/` (in Python or YAML), named in `.checkov.yaml`:

```yaml
external-checks-dir: [policies]
skip-check:
  - CKV_AWS_18 # Access logging: the bucket holds only build artefacts.
```

Fix the resource, not the policy. Skip a check only when the issue asks, with its reason beside it.
