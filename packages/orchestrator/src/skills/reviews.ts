import { repositorySkillReviews, type Database } from "@ai-office/db";
import { eq } from "drizzle-orm";

// Where the Owner's reviews of a Floor's repository Skills live (PRD FR-76,
// P1-10): the `repository_skill_reviews` table, or memory for tests. A
// repository Skill reaches an Agent or the Manager's chat only while its
// folder's files have the digest the Owner reviewed.

/** The digest of the files the Owner reviewed in one Skill folder. */
export interface RepositorySkillReview {
  /** Its folder from the repository's top, such as `.claude/skills/pdf`. */
  readonly folder: string;
  readonly digest: string;
}

export interface RepositorySkillReviewStore {
  /** Every review on a Floor. */
  list(floorId: string): Promise<RepositorySkillReview[]>;
  /** Keeps a review, in place of the folder's earlier one. */
  review(
    floorId: string,
    review: RepositorySkillReview,
    at: Date,
  ): Promise<void>;
}

/** Keeps the reviews in memory: for tests. */
export function memoryRepositorySkillReviewStore(): RepositorySkillReviewStore {
  const all = new Map<string, RepositorySkillReview & { floorId: string }>();
  return {
    list(floorId) {
      return Promise.resolve(
        [...all.values()]
          .filter((review) => review.floorId === floorId)
          .map(({ folder, digest }) => ({ folder, digest })),
      );
    },
    review(floorId, review) {
      all.set(JSON.stringify([floorId, review.folder]), {
        floorId,
        ...review,
      });
      return Promise.resolve();
    },
  };
}

/** Keeps the reviews in `repository_skill_reviews`. */
export function databaseRepositorySkillReviewStore(
  db: Database,
): RepositorySkillReviewStore {
  return {
    async list(floorId) {
      return db
        .select({
          folder: repositorySkillReviews.folder,
          digest: repositorySkillReviews.digest,
        })
        .from(repositorySkillReviews)
        .where(eq(repositorySkillReviews.floorId, floorId));
    },
    async review(floorId, review, at) {
      await db
        .insert(repositorySkillReviews)
        .values({ floorId, ...review, reviewedAt: at })
        .onConflictDoUpdate({
          target: [
            repositorySkillReviews.floorId,
            repositorySkillReviews.folder,
          ],
          set: { digest: review.digest, reviewedAt: at },
        });
    },
  };
}
