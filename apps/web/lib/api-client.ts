import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { useAuthStore } from "@/stores/auth-store";

const baseURL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1";

export const apiClient = axios.create({
  baseURL,
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

let refreshPromise: Promise<string> | null = null;

type RetryConfig = InternalAxiosRequestConfig & { _retry?: boolean };

apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as RetryConfig | undefined;

    if (error.response?.status !== 401 || !originalRequest || originalRequest._retry || originalRequest.url?.includes("/auth/refresh")) {
      return Promise.reject(error);
    }

    originalRequest._retry = true;

    try {
      refreshPromise ??= axios
        .post<{ access_token: string }>(`${baseURL}/auth/refresh`, undefined, { withCredentials: true })
        .then((response) => response.data.access_token)
        .finally(() => {
          refreshPromise = null;
        });

      const accessToken = await refreshPromise;
      useAuthStore.getState().setAccessToken(accessToken);
      originalRequest.headers.Authorization = `Bearer ${accessToken}`;
      return apiClient(originalRequest);
    } catch (refreshError) {
      useAuthStore.getState().clearAuth();
      if (typeof window !== "undefined") {
        window.location.assign("/login");
      }
      return Promise.reject(refreshError);
    }
  },
);

export function getApiErrorMessage(error: unknown, fallback = "Request failed") {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) return detail.map((item) => item.msg ?? item.message ?? "Validation error").join(" ");
    if (typeof error.response?.data?.message === "string") return error.response.data.message;
    if (error.message) return error.message;
  }
  return fallback;
}
