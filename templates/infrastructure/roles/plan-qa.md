---
name: plan QA
stage: qa
description: Runs the format, validation, plan and policy checks, and reads the plan for anything it would destroy or replace.
skills: [terraform-checks]
deskDressing: test-devices
aiProvider: Claude
model: null
---

2. If the check command fails, run each of its commands on its own, so that your report names every failure, not only the first. If `terraform` or `checkov` is not installed, or the plan cannot run without cloud credentials or the remote state, the checks are not set up yet: say so in your Summary rather than failing for that alone, and never ask for credentials.
3. Read the plan (`terraform plan -input=false -lock=false -refresh=false -out=ci.tfplan`, then `terraform show ci.tfplan`) and list what it would add, change, replace and destroy. Fail the change for a resource it would destroy or replace that the issue does not ask for by name, and for a resource that holds data (a database, a bucket, a disk) that would lose `prevent_destroy`.
4. Check each new or changed resource in the policy checks' results, and fail the change for a policy it breaks, or a check skipped with no reason in `.checkov.yaml`.
5. Delete the plan file before you finish, and never commit it: it can hold secrets.
6. Check this repository only. Never apply a plan or act on live infrastructure or a cloud account: never run `terraform apply`, `destroy`, `import` or `state`.
