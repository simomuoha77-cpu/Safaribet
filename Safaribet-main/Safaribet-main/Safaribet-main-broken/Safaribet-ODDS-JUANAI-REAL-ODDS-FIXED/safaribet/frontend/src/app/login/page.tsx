"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [emailOrPhone, setEmailOrPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.login({ emailOrPhone, password });
      sessionStorage.setItem("accessToken", res.accessToken);
      sessionStorage.setItem("user", JSON.stringify(res.user));
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="font-display font-extrabold text-2xl tracking-tight">
            Safari<span className="text-gold">Bet</span>
          </span>
        </div>

        <div className="bg-panel border border-line rounded-xl p-6">
          <h1 className="font-display font-semibold text-lg mb-1">Log in</h1>
          <p className="text-textMuted text-sm mb-6">Welcome back. Your wallet is where you left it.</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="emailOrPhone" className="block text-sm text-textMuted mb-1.5">
                Email or phone
              </label>
              <input
                id="emailOrPhone"
                type="text"
                required
                value={emailOrPhone}
                onChange={(e) => setEmailOrPhone(e.target.value)}
                className="w-full bg-ink border border-line rounded-lg px-3 py-2.5 text-sm focus-visible:outline-2 focus-visible:outline-gold"
                placeholder="you@example.com"
                autoComplete="username"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm text-textMuted mb-1.5">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-ink border border-line rounded-lg px-3 py-2.5 text-sm focus-visible:outline-2 focus-visible:outline-gold"
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-loss bg-loss/10 border border-loss/30 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gold text-ink font-semibold rounded-lg py-2.5 text-sm hover:bg-goldBright transition-colors disabled:opacity-60"
            >
              {loading ? "Logging in…" : "Log in"}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-textMuted mt-6">
          New here?{" "}
          <Link href="/register" className="text-gold hover:text-goldBright">
            Create an account
          </Link>
        </p>
      </div>
    </main>
  );
}
