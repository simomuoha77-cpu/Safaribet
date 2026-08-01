"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, CasinoGame } from "@/lib/api";

const CATEGORY_LABELS: Record<string, string> = {
  CRASH: "Crash games",
  INSTANT: "Instant games",
  SLOTS: "Slots",
  LIVE: "Live casino",
  TABLE: "Table games",
};

export default function CasinoPage() {
  const router = useRouter();
  const [games, setGames] = useState<CasinoGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  useEffect(() => {
    const token = sessionStorage.getItem("accessToken");
    if (!token) {
      router.push("/login");
      return;
    }
    api
      .getCasinoGames()
      .then((res) => setGames(res.games))
      .catch(() => setLoadError("Couldn't load games. Is the backend running?"))
      .finally(() => setLoading(false));
  }, [router]);

  async function handleLaunch(game: CasinoGame) {
    const token = sessionStorage.getItem("accessToken");
    if (!token) return;

    setLaunching(game._id);
    setLaunchError(null);
    setLaunchUrl(null);
    try {
      const res = await api.launchGame(token, game._id);
      setLaunchUrl(res.launchUrl);
    } catch (err) {
      setLaunchError(
        err instanceof ApiError
          ? err.message
          : "Couldn't launch game. Try again."
      );
    } finally {
      setLaunching(null);
    }
  }

  const grouped = groupByCategory(games);

  return (
    <main className="min-h-screen">
      <header className="border-b border-line px-5 py-4 flex items-center justify-between">
        <Link href="/dashboard" className="font-display font-extrabold text-lg tracking-tight">
          Safari<span className="text-gold">Bet</span>
        </Link>
        <span className="text-sm text-textMuted">Casino</span>
      </header>

      <div className="px-5 py-6 max-w-2xl mx-auto">
        {loading && <p className="text-textMuted text-sm">Loading games…</p>}
        {loadError && (
          <p role="alert" className="text-sm text-loss bg-loss/10 border border-loss/30 rounded-lg px-3 py-2">
            {loadError}
          </p>
        )}
        {!loading && !loadError && games.length === 0 && (
          <p className="text-textMuted text-sm">
            No games yet. Run <code className="odds text-xs bg-panel px-1.5 py-0.5 rounded">npm run seed</code> in
            the backend to load the Spribe game catalog.
          </p>
        )}

        {launchError && (
          <p role="alert" className="text-sm text-loss bg-loss/10 border border-loss/30 rounded-lg px-3 py-2 mb-4">
            {launchError}
          </p>
        )}

        {launchUrl && (
          <div className="mb-6 rounded-xl border border-gold/40 overflow-hidden bg-panel">
            <div className="flex items-center justify-between px-4 py-2 border-b border-line">
              <span className="text-xs text-textMuted">Game session</span>
              <button onClick={() => setLaunchUrl(null)} className="text-xs text-textMuted hover:text-text">
                Close
              </button>
            </div>
            <iframe src={launchUrl} className="w-full h-[480px]" title="Casino game" />
          </div>
        )}

        {grouped.map(([category, categoryGames]) => (
          <div key={category} className="mb-6">
            <p className="text-xs uppercase tracking-wide text-textMuted mb-2">
              {CATEGORY_LABELS[category] ?? category}
            </p>
            <div className="grid grid-cols-2 gap-3">
              {categoryGames.map((game) => (
                <button
                  key={game._id}
                  onClick={() => handleLaunch(game)}
                  disabled={launching === game._id}
                  className="text-left rounded-xl border border-line bg-panel p-4 hover:border-gold/60 transition-colors disabled:opacity-60"
                >
                  <p className="font-display font-semibold">{game.name}</p>
                  <p className="text-xs text-textMuted mt-1">
                    {launching === game._id ? "Launching…" : "Tap to play"}
                  </p>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

function groupByCategory(games: CasinoGame[]): [string, CasinoGame[]][] {
  const groups = new Map<string, CasinoGame[]>();
  for (const g of games) {
    if (!groups.has(g.category)) groups.set(g.category, []);
    groups.get(g.category)!.push(g);
  }
  return Array.from(groups.entries());
}
