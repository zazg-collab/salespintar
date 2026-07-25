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

  clearError: () => set({ error: null }),
}));
