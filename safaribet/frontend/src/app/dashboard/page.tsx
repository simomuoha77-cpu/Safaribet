"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";

interface UserInfo {
  id: string;
  email: string;
  fullName: string;
  vipLevel: number;
}

interface Balance {
  main: string;
  bonus: string;
  cashback: string;
  currency: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = sessionStorage.getItem("accessToken");
    const storedUser = sessionStorage.getItem("user");

    if (!token || !storedUser) {
      router.push("/login");
      return;
    }

    setUser(JSON.parse(storedUser));

    api
      .getBalance(token)
      .then(setBalance)
      .catch(() => setError("Couldn't load your wallet. Try refreshing."))
      .finally(() => setLoading(false));
  }, [router]);

  async function handleLogout() {
    await api.logout().catch(() => {});
    sessionStorage.clear();
    router.push("/login");
  }

  if (!user) return null;

  return (
    <main className="min-h-screen">
      <header className="border-b border-line px-5 py-4 flex items-center justify-between">
        <span className="font-display font-extrabold text-lg tracking-tight">
          Safari<span className="text-gold">Bet</span>
        </span>
        <button onClick={handleLogout} className="text-sm text-textMuted hover:text-text">
          Log out
        </button>
      </header>

      <div className="px-5 py-6 max-w-2xl mx-auto">
        <h1 className="font-display font-semibold text-xl mb-1">
          Hi, {user.fullName.split(" ")[0]}
        </h1>
        <p className="text-textMuted text-sm mb-6">VIP Level {user.vipLevel}</p>

        {loading && <p className="text-textMuted text-sm">Loading wallet…</p>}
        {error && (
          <p role="alert" className="text-sm text-loss bg-loss/10 border border-loss/30 rounded-lg px-3 py-2 mb-4">
            {error}
          </p>
        )}

        {balance && (
          <div className="grid grid-cols-3 gap-3">
            <BalanceCard label="Main" amount={balance.main} currency={balance.currency} highlight />
            <BalanceCard label="Bonus" amount={balance.bonus} currency={balance.currency} />
            <BalanceCard label="Cashback" amount={balance.cashback} currency={balance.currency} />
          </div>
        )}

        <div className="mt-8 grid grid-cols-2 gap-3">
          <Link
            href="/sportsbook"
            className="rounded-xl border border-line bg-panel p-5 hover:border-gold/60 transition-colors"
          >
            <p className="font-display font-semibold">Sportsbook</p>
            <p className="text-xs text-textMuted mt-1">Test fixtures — real bet placement</p>
          </Link>
          <Link
            href="/casino"
            className="rounded-xl border border-line bg-panel p-5 hover:border-gold/60 transition-colors"
          >
            <p className="font-display font-semibold">Casino</p>
            <p className="text-xs text-textMuted mt-1">Spribe games — needs credentials to launch</p>
          </Link>
        </div>
      </div>
    </main>
  );
}

function BalanceCard({
  label,
  amount,
  currency,
  highlight = false,
}: {
  label: string;
  amount: string;
  currency: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        highlight ? "bg-panelRaised border-gold/40" : "bg-panel border-line"
      }`}
    >
      <p className="text-xs text-textMuted mb-1">{label}</p>
      <p className="odds text-lg font-bold">
        {currency} {amount}
      </p>
    </div>
  );
}
