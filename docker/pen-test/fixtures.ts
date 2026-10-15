// The fixture ID listing (Enablement E2, #188) the credentials package (E4,
// #190) delivers to the red team: the seeded Floor IDs, Agent IDs and the
// throwaway repository's issue numbers, so the testers start from the IDs
// rather than from a directory listing. It never holds a credential: the
// canary credentials are the stub's (docs/pen-testing/stack.md), delivered as
// E4 says, and the corpus canaries are harmless beacons.

import { writeFileSync } from "node:fs";

import type { Hypothesis } from "./corpus.ts";
import type { GenerateTargetResult } from "./generate-target.ts";
import type { SeedResult } from "./seed.ts";

/** The fixture ID listing, as JSON for the credentials package. */
export interface FixtureListing {
  /** When it was written. */
  readonly generatedAt: string;
  /** The throwaway target repository, as `owner/name`. */
  readonly targetRepository: string;
  readonly floors: readonly {
    readonly id: string;
    readonly repository: string;
    readonly mergePolicy: string;
    readonly agents: readonly {
      readonly id: string;
      readonly name: string;
      readonly role: string;
      readonly stage: string | null;
    }[];
  }[];
  readonly aiAccounts: readonly string[];
  /** The hostile-content corpus in the database. */
  readonly corpus: {
    readonly skill: { readonly id: string; readonly name: string };
    readonly template: { readonly id: string; readonly name: string };
    readonly memoryProposal: { readonly id: number; readonly floorId: string };
    /** Every corpus item, by id, kind, hypothesis and canary. */
    readonly items: readonly {
      readonly id: string;
      readonly kind: string;
      readonly hypothesis: Hypothesis;
      readonly canary: string;
    }[];
  };
  /** The issues seeded into the target repository, when generated. */
  readonly issues: readonly {
    readonly id: string;
    readonly canary: string;
    readonly number: number;
  }[];
}

/** Builds the fixture ID listing from the seed's result. */
export function fixtureListing(
  result: SeedResult,
  options: {
    readonly targetRepository: string;
    readonly generated?: GenerateTargetResult;
    readonly now?: () => Date;
  },
): FixtureListing {
  const now = options.now ?? (() => new Date());
  return {
    generatedAt: now().toISOString(),
    targetRepository: options.targetRepository,
    floors: result.floors.map((floor) => ({
      id: floor.id,
      repository: floor.repository,
      mergePolicy: floor.mergePolicy,
      agents: floor.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        stage: agent.stage,
      })),
    })),
    aiAccounts: result.aiAccounts,
    corpus: {
      skill: result.skill,
      template: result.template,
      memoryProposal: result.memoryProposal,
      items: result.corpus.map((item) => ({
        id: item.id,
        kind: item.kind,
        hypothesis: item.hypothesis,
        canary: item.canary,
      })),
    },
    issues: options.generated?.issues ?? [],
  };
}

/** Writes the fixture ID listing to `path`, as pretty JSON. */
export function writeFixtureListing(
  path: string,
  listing: FixtureListing,
): void {
  writeFileSync(path, `${JSON.stringify(listing, null, 2)}\n`, { mode: 0o600 });
}
