'use client';

import { create } from 'zustand';
import { apiPost, setTokens, clearTokens, getAccessToken, apiGet } from '../lib/api';

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface Business {
  id: string;
  name: string;
  slug: string;
  metaCapiEnabled?: boolean;
}

interface AuthState {
  user: User | null;
  business: Business | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (businessName: string, name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => void;
  fetchMe: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  business: null,
  isAuthenticated: !!getAccessToken(),
  isLoading: false,
  error: null,

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const data = await apiPost<any>('/auth/login', { email, password });
      setTokens(data.accessToken, data.refreshToken);
      set({
        user: data.user,
        business: data.business,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (err: any) {
      set({ error: err.message, isLoading: false });
      throw err;
    }
  },

  register: async (businessName: string, name: string, email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const data = await apiPost<any>('/auth/register', {
        businessName, name, email, password,
      });
      setTokens(data.accessToken, data.refreshToken);
      set({
        user: data.user,
        business: data.business,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (err: any) {
      set({ error: err.message, isLoading: false });
      throw err;
    }
  },

  logout: async () => {
    try {
      await apiPost('/auth/logout');
    } catch {}
    clearTokens();
    set({ user: null, business: null, isAuthenticated: false });
  },

  checkAuth: () => {
    set({ isAuthenticated: !!getAccessToken() });
  },

  /**
   * Pulihkan `user` & `business` dari server memakai token yang tersimpan.
   *
   * Store ini tidak memakai middleware `persist`, jadi yang bertahan setelah
   * refresh hanya token di localStorage — objek user hilang. Tanpa pemulihan
   * ini, `isAuthenticated` bernilai true sementara `user` null, dan semua UI
   * yang bergantung pada role diam-diam menghilang.
   */
  fetchMe: async () => {
    if (!getAccessToken()) return;
    try {
      const data = await apiGet<any>('/auth/me');
      set({ user: data.user, business: data.business, isAuthenticated: true });
    } catch {
      // Token kedaluwarsa/tidak sah: apiRequest sudah menangani redirect ke
      // /login saat refresh token ikut gagal, jadi di sini cukup diam.
    }
  },

  clearError: () => set({ error: null }),
}));
