import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";

// General Settings' Credits: who made AI Office, and whose work it is built
// on. THIRD-PARTY-NOTICES.md has each asset's source and licence.

export interface Credit {
  readonly name: string;
  /** What they gave AI Office. */
  readonly for: string;
  readonly href: string;
}

/** The people behind AI Office, and the work it uses most directly. */
export const credits: readonly Credit[] = [
  {
    name: "Adrian Eyre",
    for: "Created, designed and built AI Office",
    href: "https://github.com/adrianeyre",
  },
  {
    name: "Matt Pocock",
    for: "The built-in Skills (grill-with-docs, wayfinder, to-tickets, to-spec, pr, tdd and more), adapted from his skills, and Sandcastle, which AI Office is built with",
    href: "https://github.com/mattpocock/skills",
  },
  {
    name: "Dex Horthy (Humanlayer)",
    for: "The pr Skill's Summary section, from his show-me skill",
    href: "https://github.com/dexhorthy",
  },
  {
    name: "Kenney",
    for: "The Furniture Kit models in the 3D Office",
    href: "https://kenney.nl/assets/furniture-kit",
  },
  {
    name: "The Inter and JetBrains Mono Project Authors",
    for: "The fonts, and the wordmark in the default logo",
    href: "https://github.com/rsms/inter",
  },
  {
    name: "Lucide Contributors",
    for: "The icons",
    href: "https://github.com/lucide-icons/lucide",
  },
  {
    name: "The open-source projects AI Office runs on",
    for: "React, Three.js and React Three Fiber, TanStack, Tailwind CSS and shadcn/ui, Zod, Fastify, Drizzle ORM, PostgreSQL and many more",
    href: "https://github.com/adrianeyre/ai-office/blob/main/THIRD-PARTY-NOTICES.md",
  },
];

export function CreditsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Credits</h2>
        </CardTitle>
        <CardDescription>
          The people who made AI Office, and whose work it is built on.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul aria-label="Credits" className="space-y-3">
          {credits.map((credit) => (
            <li key={credit.name} className="text-sm">
              <a
                href={credit.href}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline underline-offset-4"
              >
                {credit.name}
              </a>
              <p className="text-muted-foreground">{credit.for}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
