import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="display text-4xl">Prisim R2</h1>
      <p className="text-muted-foreground">
        Multi-tenant Cloudflare R2 bucket manager. Project is scaffolding (task
        1.1 of the implementation plan).
      </p>
      <div className="flex items-center gap-3">
        <Button asChild>
          <Link href="/login">Go to login</Link>
        </Button>
        <Button variant="outline">Secondary</Button>
      </div>
    </main>
  );
}
