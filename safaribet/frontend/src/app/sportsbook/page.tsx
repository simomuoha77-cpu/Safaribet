"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, SportsEvent, SportsMarket } from "@/lib/api";

interface SlipSelection {
  eventId: string;
  eventLabel: string;
  marketType: string;
  selection: string;
  odds: number;
}

export default function SportsbookPage() {
  const router = useRouter();
  const [events, setEvents] = useState<SportsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [slip, setSlip] = useState<SlipSelection | null>(null);
  const [stake, setStake] = useState("");
  const [placing, setPlacing] = useState(false);
  const [betError, setBetError] = useState<string | null>(null);
  const [betSuccess, setBetSuccess] = useState(false);

  useEffect(() => {
    const token = sessionStorage.getItem("accessToken");
    if (!token) {
      router.push("/login");
      return;
    }
    api
      .getEvents()
      .then((res) => setEvents(res.events))
      .catch(() => setLoadError("Couldn't load events. Is the backend running?"))
      .finally(() => setLoading(false));
  }, [router]);

  function selectOdds(event: SportsEvent, market: SportsMarket) {
    setBetError(null);
    setBetSuccess(false);
    setSlip({
      eventId: event.id,
      eventLabel: `${event.homeTeam} vs ${event.awayTeam}`,
      marketType: market.marketType,
      selection: market.selection,
      odds: Number(market.odds),
    });
  }

  async function handlePlaceBet() {
    const token = sessionStorage.getItem("accessToken");
    if (!token || !slip) return;

    const stakeNum = Number(stake);
    if (!stakeNum || stakeNum <= 0) {
      setBetError("Enter a stake amount.");
      return;
    }

    setPlacing(true);
    setBetError(null);
    try {
      await api.placeBet(token, {
        eventId: slip.eventId,
        marketType: slip.marketType,
        selection: slip.selection,
        odds: slip.odds,
        stake: stakeNum,
      });
      setBetSuccess(true);
      setSlip(null);
      setStake("");
    } catch (err) {
      setBetError(err instanceof ApiError ? err.message : "Couldn't place bet. Try again.");
    } finally {
      setPlacing(false);
    }
  }

  return (
    <main className="min-h-screen">
      <header className="border-b border-line px-5 py-4 flex items-center justify-between">
        <Link href="/dashboard" className="font-display font-extrabold text-lg tracking-tight">
          Safari<span className="text-gold">Bet</span>
        </Link>
        <span className="text-sm text-textMuted">Sportsbook</span>
      </header>

      <div className="px-5 py-6 max-w-2xl mx-auto pb-32">
        {loading && <p className="text-textMuted text-sm">Loading fixtures…</p>}
        {loadError && (
          <p role="alert" className="text-sm text-loss bg-loss/10 border border-loss/30 rounded-lg px-3 py-2">
            {loadError}
          </p>
        )}
        {!loading && !loadError && events.length === 0 && (
          <p className="text-textMuted text-sm">
            No fixtures yet. Run <code className="odds text-xs bg-panel px-1.5 py-0.5 rounded">npm run seed</code> in
            the backend to load test fixtures.
          </p>
        )}

        <div className="space-y-3">
          {events.map((event) => (
            <div key={event.id} className="bg-panel border border-line rounded-xl p-4">
              <div className="flex items-baseline justify-between mb-1">
                <p className="text-xs text-textMuted">{event.league}</p>
                <p className="text-xs text-textMuted">
                  {new Date(event.startTime).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              <p className="font-display font-semibold mb-3">
                {event.homeTeam} <span className="text-textMuted font-normal">vs</span> {event.awayTeam}
              </p>

              {groupByMarket(event.markets).map(([marketType, markets]) => (
                <div key={marketType} className="mb-2 last:mb-0">
                  <p className="text-[11px] uppercase tracking-wide text-textMuted mb-1.5">
                    {marketType.replace(/_/g, " ")}
                  </p>
                  <div className="flex gap-2 flex-wrap">
                    {markets.map((m) => {
                      const active =
                        slip?.eventId === event.id &&
                        slip.marketType === m.marketType &&
                        slip.selection === m.selection;
                      return (
                        <button
                          key={m.id}
                          onClick={() => selectOdds(event, m)}
                          className={`rounded-lg border px-3 py-2 text-left min-w-[88px] transition-colors ${
                            active
                              ? "bg-gold border-gold text-ink"
                              : "bg-ink border-line hover:border-gold/60"
                          }`}
                        >
                          <span className="block text-xs opacity-80">{m.selection}</span>
                          <span className="odds block font-bold">{Number(m.odds).toFixed(2)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Bet slip */}
      {slip && (
        <div className="fixed bottom-0 left-0 right-0 bg-panelRaised border-t border-gold/40 px-5 py-4">
          <div className="max-w-2xl mx-auto">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-sm font-medium">{slip.eventLabel}</p>
                <p className="text-xs text-textMuted">
                  {slip.marketType.replace(/_/g, " ")}: {slip.selection} @{" "}
                  <span className="odds text-gold">{slip.odds.toFixed(2)}</span>
                </p>
              </div>
              <button onClick={() => setSlip(null)} className="text-textMuted text-sm hover:text-text">
                Clear
              </button>
            </div>

            <div className="flex gap-2 items-center">
              <input
                type="number"
                min="1"
                placeholder="Stake (KES)"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                className="flex-1 bg-ink border border-line rounded-lg px-3 py-2.5 text-sm focus-visible:outline-2 focus-visible:outline-gold"
              />
              <button
                onClick={handlePlaceBet}
                disabled={placing}
                className="bg-gold text-ink font-semibold rounded-lg px-5 py-2.5 text-sm hover:bg-goldBright transition-colors disabled:opacity-60 whitespace-nowrap"
              >
                {placing ? "Placing…" : `Place bet`}
              </button>
            </div>

            {stake && Number(stake) > 0 && (
              <p className="text-xs text-textMuted mt-2">
                Potential win: <span className="odds text-win">KES {(Number(stake) * slip.odds).toFixed(2)}</span>
              </p>
            )}

            {betError && <p className="text-xs text-loss mt-2">{betError}</p>}
          </div>
        </div>
      )}

      {betSuccess && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-win text-ink text-sm font-medium rounded-lg px-4 py-2 shadow-lg">
          Bet placed
        </div>
      )}
    </main>
  );
}

function groupByMarket(markets: SportsMarket[]): [string, SportsMarket[]][] {
  const groups = new Map<string, SportsMarket[]>();
  for (const m of markets) {
    if (!groups.has(m.marketType)) groups.set(m.marketType, []);
    groups.get(m.marketType)!.push(m);
  }
  return Array.from(groups.entries());
}
