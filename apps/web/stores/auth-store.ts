import { create } from "zustand";

type JwtPayload = {
  sub?: string;
  user_id?: string;
  org_id?: string;
  exp?: number;
};

function decodeJwt(token: string): JwtPayload {
  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "="));
    return JSON.parse(decoded) as JwtPayload;
  } catch {
    return {};
  }
}

type AuthState = {
  accessToken: string | null;
  orgId: string | null;
  userId: string | null;
  bootstrapped: boolean;
  setAccessToken: (token: string) => void;
  clearAuth: () => void;
  setBootstrapped: (value: boolean) => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  orgId: null,
  userId: null,
  bootstrapped: false,
  setAccessToken: (token) => {
    const payload = decodeJwt(token);
    set({
      accessToken: token,
      orgId: payload.org_id ?? null,
      userId: payload.user_id ?? payload.sub ?? null,
      bootstrapped: true,
    });
  },
  clearAuth: () => set({ accessToken: null, orgId: null, userId: null, bootstrapped: true }),
  setBootstrapped: (value) => set({ bootstrapped: value }),
}));
