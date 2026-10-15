# Only the Owner accepts Role memory

Role memory is what Agents of one Role on one Floor have learned, mounted into every later sandbox of that Role and quoted in every later reviewer's prompt. Agents propose its entries at the end of a task, so a proposal is text an Agent wrote after reading an issue, the repository and the web, any of which an attacker may control. FR-55 let the Manager or the Owner accept a proposal, and the Manager's hourly review accepted through its own Model. That Model reads the very proposal it decides on, so one hostile issue could reach every later Agent of the Role with no human in the way (pen-test finding P1-4). So only the Owner accepts an entry. The Manager still reviews every proposal: one it rejects is turned down, and one it would accept is **recommended**, waiting for the Owner with the Manager's reason and reaching no Agent until the Owner accepts it.

## Considered Options

- **Keep the Manager's acceptance, and quote Role memory as untrusted data in every prompt**, as reviewers already have it: the entry would still reach every later Agent on a model's say-so, only fenced. A fence lowers the odds that a model obeys hostile text; it does not stop the text arriving, and Role memory exists to be followed.
- **Take the Manager out of Role memory altogether**: the Owner would sift every proposal unaided. The Manager's review costs nothing in safety when it can only reject or recommend, and it saves the Owner reading what plainly only concerns one issue.

## Consequences

- This narrows FR-55: "accepted by the Manager or the Owner" becomes "accepted by the Owner, on the Manager's recommendation".
- A Role memory entry has a fifth status, `recommended` (decided by the Manager), beside `proposed`, `accepted`, `rejected` and `removed`. The database refuses an accepted or removed entry not decided by the Owner, and a recommended one not decided by the Manager.
- The Manager is asked once about each proposal: what it recommended waits for the Owner, not for it. The Floor admin lists recommended entries among the proposals waiting, with the Manager's reason; `memory.role_changed` has a `recommended` change.
- Role memory grows only as fast as the Owner reads it. Nothing else changes for an entry the Owner accepted: it is mounted as `ROLE.md`, and quoted for reviewers.
