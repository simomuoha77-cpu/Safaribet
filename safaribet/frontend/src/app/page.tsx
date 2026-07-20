import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <span className="font-display font-extrabold text-3xl tracking-tight block mb-3">
          Safari<span className="text-gold">Bet</span>
        </span>
        <p className="text-textMuted mb-8">Sportsbook & casino. Real accounts, real balances.</p>
        <div className="flex gap-3 justify-center">
          <Link href="/login" className="bg-gold text-ink font-semibold rounded-lg px-5 py-2.5 text-sm hover:bg-goldBright transition-colors">
            Log in
          </Link>
          <Link href="/register" className="border border-line rounded-lg px-5 py-2.5 text-sm hover:border-gold transition-colors">
            Create account
          </Link>
        </div>
      </div>
    </main>
  );
}
