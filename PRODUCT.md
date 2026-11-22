# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers and small teams who already pay for AI accounts (Claude and
ChatGPT subscriptions, API keys, or their own models through Ollama) and
want a team of AI Agents to work their GitHub issues, on their own machine
or a single server. On the website they are evaluating AI Office, then
installing it: they read what it does, check the requirements and follow
the quick start or the full setup guide.

## Product Purpose

AI Office is a self-hosted web app in which AI Agents work GitHub issues
end to end, shown as a 3D office. Each repository is a Floor with a Manager
and a team of Agents in Roles; an issue moves through the Stages (work,
review, QA, docs) to a merged pull request, or to the Owner on the Notice
Board. A built-in AI Gateway load-balances every model call across the
Owner's AI Accounts and enforces Token Caps per office, Floor, Agent and
issue. Success: running several agents at once becomes visible, bounded
and controllable, and fun to watch.

## Positioning

The work of a team of coding agents is shown as a place: a soft-lit
miniature office where each repository is a Floor, each Agent has a desk
and a monitor you can click, the Manager plans on a whiteboard and hands
off tickets desk to desk. It runs on the AI Accounts the Owner already
pays for, through its own gateway, with hard caps.

## Operating Context

The Owner runs AI Office with `pnpm dev` or `docker compose` on Windows
(WSL 2), macOS or Linux, or on an EC2 instance behind Caddy. It works
through a GitHub App on the Owner's repositories, labels and branch
protection. Agents run Claude Code, Codex or opencode in Docker sandboxes
whose only route out is the AI Gateway. The Owner may leave the 3D Office
on a second monitor all day.

## Capabilities and Constraints

- Terminology is fixed by `GLOSSARY.md` (Owner, Floor, Agent, Manager,
  Role, Stage, Floor Template, AI Gateway, AI Account, Gateway Key, Token
  Cap, Notice Board, Batch, Plan, Kickoff, Wrap-up and the rest); use its
  terms exactly.
- Requirements: Node 26 or later, pnpm 12 or later, Docker, Git, a GitHub
  account and at least one AI Account.
- The website (`site/`) is a static page built by Vite and published to
  GitHub Pages at `ai-office.adrianeyre.co.uk`; it copies the screenshots
  from `docs/images/` and the logo and icons from `apps/web`.
- App screenshots come from `pnpm screenshots` (Playwright against the
  built app with a fake GitHub); they are never hand-edited.
- Licence: not chosen yet; no licence is granted until release. Third-party
  assets carry their own licences (`THIRD-PARTY-NOTICES.md`).

## Brand Commitments

- The name is AI Office; the logo and icon live in `apps/web/src/brand/`.
- The 3D Office's look is set in `docs/reference/art-direction.md`: a
  premium indie management game, soft-lit, warm neutrals, colour kept for
  what means something (the four Stages and the states), no pure black or
  white. Its palette is code in `packages/shared/src/palette.ts`.
- Voice: plain, exact British English, product terms capitalised as in
  the glossary, no hype.

## Evidence on Hand

- Real screenshots of every page of the app in `docs/images/`.
- The full product and setup documentation in `docs/guide/` and
  `docs/processes/`.
- No users, customers, testimonials, benchmarks, pricing or star counts
  exist to cite; none may be invented.

## Product Principles

1. Visible, bounded and controllable: every claim shows what is happening,
   what it costs and where the limit is.
2. Prove with the product: real screenshots and faithful demonstrations
   over adjectives.
3. Self-hosted and the Owner's own: their machine, their AI Accounts,
   their repositories, their merge rules.
4. Calm enough to leave on all day: craft and warmth over spectacle.

## Accessibility & Inclusion

WCAG 2.2 AA. Colour never carries meaning alone; reduced motion is
honoured (the app has a 2D view and reduced motion for phones and
tablets).
