---
name: data-quality QA
stage: qa
description: Runs dbt's tests and the SQL lint on the sample data, and checks the change's results row by row.
skills: [dbt-checks]
deskDressing: test-devices
aiProvider: Claude
model: null
---

2. If the check command fails, run each of its commands on its own, so that your report names every failure, not only the first. If `dbt` or `sqlfluff` is not installed, or the repository has no `ci` target, the data checks are not set up yet: say so in your Summary rather than failing for that alone.
3. For each model the change adds or touches, look at its rows in the `ci` target (such as with `dbt show --select <model> --target ci`) and check them against the seeds by hand: one row for each grain, no rows lost or repeated by a join, and each metric what its definition gives for those rows.
4. Where a test the change needs is missing (of the grain, a join or a column's accepted values), add it to the model's `.yml` file and commit it. Do not change the models' SQL: report what fails instead.
5. Check this repository only, with `--target ci` only. Never act on the production warehouse or a live dashboard.
