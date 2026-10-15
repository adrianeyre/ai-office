# Issue #231: [fix] S2-2 — On the documented EC2 set-up a sandbox can reach the instance metadata service and read the instance role's credentials — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no EC2, no network beyond the registry and the model). The fix is
commit `6f94dfa`,
`fix(security): S2-2 the EC2 set-up sets a metadata hop limit of 1, and the sandbox relay refuses the metadata service`,
on top of `652959e` (S2-1's fix, #229). Its blocker, the S2 probe (#193),
is in the tree: `docs/pen-testing/assessments/S2.md` and
`docker/sandbox-isolation.pen-test.test.ts`.

This is the remediation of finding **S2-2** (`severity:high`, H2).

## What was fixed

The EC2 process picked Ubuntu 24.04 and IMDSv2 only, suggested an IAM role
for the backups, and never set the hop limit, so the AMI's default of 2
let a container get an IMDSv2 token and read the role's credentials.

- **`docs/processes/deploying-to-ec2.md`, "Launch it":** **Advanced
  details → Metadata version: V2 only (token required), and Metadata
  response hop limit: 1**, with why: a container's request takes a second
  hop, so neither the app nor any sandbox reaches the metadata service,
  while the host's own AWS CLI (the backups) still does.
- **The sandbox relay** (`docker/sandbox-relay/relay.ts`) now refuses to
  relay to a name that resolves, even among other addresses, to the
  metadata service (`169.254.169.254`, EC2's IPv6 `fd00:ec2::254`, ECS's
  `169.254.170.2`) or any other link-local, loopback, unspecified,
  multicast or reserved address, IPv4-mapped forms included
  (`isForbiddenAddress`). It connects to the address it checked, never
  resolving the name again. IP addresses were already refused (S2-1).

### Sibling paths

- **An instance launched before this, or by anything but the console
  steps** (the CLI, a template, #117's infrastructure as code later): the
  document gives `aws ec2 modify-instance-metadata-options` with
  `--http-tokens required --http-put-response-hop-limit 1`, and `aws ec2 describe-instances … --query
  'Reservations[].Instances[].MetadataOptions'` to check it.
- **Whatever hop limit an instance has** (an account default, a forgotten
  step): a sandbox's network has no route out (S2-1), so it has none to
  `169.254.169.254`, and the relay, its one way out, refuses it by address
  and by name.
- **The backups** now say to install the AWS CLI on the instance itself,
  never in a container, and to give the role nothing but the bucket.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "the
      documented EC2 set-up keeps sandboxes from the instance metadata
      service (a hop limit of 1, or a block)" is an `it`, its body
      unchanged.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (S2-2): it still
      picks Ubuntu 24.04, IMDSv2 only and an IAM role on the instance, but
      no longer leaves the hop limit at the AMI's default: it sets 1". Where
      the pin had `not.toMatch(/hop limit|HopLimit/i)`, it now finds the
      hop limit, set to 1 beside "V2 only", and none above 1.
- [x] **Sibling paths with the same flaw are fixed and tested.** "sibling
      (S2-2): an instance launched before, or another way, is given the
      same hop limit, and the document says how to check it"; "sibling
      (S2-2): whatever hop limit an instance has, a sandbox's network has no
      route to 169.254.169.254, and the sandbox relay refuses it, by address
      or by a name that resolves to it"; in `relay.test.ts`, "refuses an
      allowed name that resolves to the instance metadata service, loopback
      or link-local, even alongside a public address" and "the addresses a
      sandbox never reaches".
- [x] **The assessment's findings table marks `S2-2` fixed.**
      `docs/pen-testing/assessments/S2.md`: **fixed** (issue #231) with the
      commit's subject (hash filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass; `pnpm test` has only the two failures that were there
      before this run, unrelated. The real output is in
      [issue-233.md](issue-233.md#real-output-of-the-checks).

## Decisions

1. **A hop limit of 1, not the metadata service turned off.** The
   document's backups use the instance's IAM role from the host, so the
   service stays on for the host, one hop away, and no container reaches
   it. Turning it off would break the backups to S3 the document
   recommends.
2. **The app's container loses the metadata service too.** Nothing in AI
   Office uses it, and the app's container holds the Docker socket, so it
   is the last thing that should hold the role.
3. **The relay refuses link-local, loopback, unspecified, multicast and
   reserved addresses, but not private ranges** (10/8, 172.16/12,
   192.168/16). A name the Owner lists that resolves privately (a registry
   inside their network) is their choice; the relay only ever reaches port
   443 of it, never the stack's own ports.

## Noticed, out of scope

- **The relay itself** is on the default network, which has a route out.
  With a hop limit of 2 it could reach the metadata service, but it only
  does what its code says, and that refuses it; with the documented limit
  of 1 it cannot.
- **#117** (the instance as infrastructure as code) should set
  `http_put_response_hop_limit = 1` when it is built; there is no such
  code in the tree yet.
- **The PRD's register (H2)** still describes the old document; it is the
  round's opening register, so it was left as written.

## What could not be verified here

There is no EC2 and no Docker here. The AWS defaults (Ubuntu 24.04 AMIs
registered with `ImdsSupport: v2.0`, and so a hop limit of 2) come from
the assessment's reading of AWS's documentation, not a run. On the stack,
as the issue says: an instance launched as the document now says should
show `"HttpPutResponseHopLimit": 1` in `aws ec2 describe-instances`, and
from a sandbox an IMDSv2 token request to `169.254.169.254` should find no
route (and, through the relay, be refused with a `refused` line in its
log). The console's field names were taken from the EC2 launch wizard as
AWS documents it.
