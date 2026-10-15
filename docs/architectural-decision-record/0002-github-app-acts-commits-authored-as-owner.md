# A GitHub App acts; commits are authored as the Owner

An AI Office GitHub App, installed on each Floor's repository, pushes branches, opens pull requests, posts AI reviews, comments on issues and merges. Every commit's author and committer are the Owner (configurable; default GitHub user `adrianeyre`, using their noreply email), with an `Agent:` trailer naming the Agent, its Role and its AI Provider, so agent commits stay distinguishable in history. The App, not the Owner's token, opens pull requests because GitHub refuses an approval from a pull request's own author: with the Owner as author, the Owner could never approve an agent's pull request.

## Consequences

- AI reviewers' verdicts are posted as App reviews, but GitHub's own approval count is not what decides an automatic merge. The Merge Policy gate does: every required reviewer Agent approves, no blocking comments remain, CI passes, and the Review Loop stayed within its Round Cap. Only then does the App merge.
- Each Floor's default branch should be protected to require passing CI and to forbid direct pushes, but should not require an approval count, or an automatic merge could never happen. Floors whose Merge Policy sends pull requests to the Owner work with any protection, since the Owner approves the App's pull request as a normal reviewer.
- Signed commits are not supported: commits that claim the Owner as author cannot carry the Owner's signature unless the Owner gives AI Office a signing key, which is a separate, deliberate decision.
