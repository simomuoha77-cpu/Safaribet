const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: RequestInit & { accessToken?: string } = {}
): Promise<T> {
  const { accessToken, headers, ...rest } = options;

  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    credentials: "include", // send/receive the httpOnly refresh cookie
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(data.error || "Request failed", res.status);
  }

  return data as T;
}

export interface AuthResponse {
  accessToken: string;
  user: { id: string; email: string; fullName: string; vipLevel: number };
}

export const api = {
  register: (payload: {
    email: string;
    phone: string;
    password: string;
    fullName: string;
    referralCode?: string;
  }) => request<{ message: string; userId: string }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  }),

  login: (payload: { emailOrPhone: string; password: string }) =>
    request<AuthResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  logout: () => request<{ message: string }>("/api/auth/logout", { method: "POST" }),

  getBalance: (accessToken: string) =>
    request<{ main: string; bonus: string; cashback: string; currency: string }>(
      "/api/wallet/balance",
      { accessToken }
    ),

  getHistory: (accessToken: string) =>
    request<{ entries: unknown[] }>("/api/wallet/history", { accessToken }),

  getEvents: () => request<{ events: SportsEvent[] }>("/api/sports/events"),

  placeBet: (
    accessToken: string,
    payload: { eventId: string; marketType: string; selection: string; odds: number; stake: number }
  ) =>
    request<{ bet: unknown }>("/api/sports/bets", {
      method: "POST",
      accessToken,
      body: JSON.stringify(payload),
    }),

  getMyBets: (accessToken: string) =>
    request<{ bets: unknown[] }>("/api/sports/bets", { accessToken }),

  getCasinoGames: () => request<{ games: CasinoGame[] }>("/api/casino/games"),

  launchGame: (accessToken: string, gameId: string) =>
    request<{ launchUrl: string; sessionId: string }>("/api/casino/launch", {
      method: "POST",
      accessToken,
      body: JSON.stringify({ gameId }),
    }),
};

export interface CasinoGame {
  _id: string;
  name: string;
  category: string;
  externalGameId: string;
  isActive: boolean;
  thumbnailUrl?: string;
}

export interface SportsMarket {
  id: string;
  marketType: string;
  selection: string;
  odds: string;
}

export interface SportsEvent {
  id: string;
  sport: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  markets: SportsMarket[];
}
