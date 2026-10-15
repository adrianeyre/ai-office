---
name: dbt-checks
description: How a Data & analytics Floor checks a dbt repository on sample data (the `ci` target, seeds, dbt's tests and the SQL lint), and how to set them up. Use it when the checks fail, are missing, or need changing.
---

# The data checks

A Data & analytics Floor checks every change on sample data in the repository, never on the production warehouse. Its check command is:

```sh
dbt deps && dbt seed --target ci && dbt run --target ci && dbt test --target ci && sqlfluff lint models
```

| Command | What it does |
| --- | --- |
| `dbt deps` | installs the dbt packages `packages.yml` lists |
| `dbt seed --target ci` | loads the sample data in `seeds/` into the local DuckDB file |
| `dbt run --target ci` | builds every model in that file |
| `dbt test --target ci` | runs every test on the models and sources, and fails naming each one that finds a problem |
| `sqlfluff lint models` | lints every model's SQL by the rules in `.sqlfluff`, and fails naming the file and the line |

The Floor's setup command installs `requirements.txt`, which pins `dbt-duckdb`, `sqlfluff` and `sqlfluff-templater-dbt`.

## The `ci` target

`profiles.yml`, committed at the top of the repository, holds a `ci` target with no credentials, under the profile `dbt_project.yml` names:

```yaml
analytics:
  target: ci
  outputs:
    ci:
      type: duckdb
      path: ci.duckdb
      threads: 4
```

with `ci.duckdb` in `.gitignore`. The production targets are given to dbt outside the repository (with `--profiles-dir` or `DBT_PROFILES_DIR`, in the Owner's own pipeline), never here.

## Sample data

- Each source table has a seed standing in for it, named as the table, with a few rows that show each case the models handle: a null, a late row, a repeated one.
- Each source finds its seed when the target is `ci`, such as with `schema: "{{ 'main' if target.name == 'ci' else 'raw' }}"` in its `.yml` file.
- Sample rows are made up, never copied from production.
- SQL that only the production warehouse understands runs in DuckDB too through dbt's cross-database functions, such as `dbt.dateadd` and `dbt.safe_cast`.

## The SQL lint

`.sqlfluff` sets the dialect the models are written in and the dbt templater:

```ini
[sqlfluff]
dialect = duckdb
templater = dbt

[sqlfluff:templater:dbt]
target = ci
```

Fix the SQL, not the rules: change `.sqlfluff` only when the issue asks. `sqlfluff fix models` fixes most of what the lint finds; read its changes before committing them.
