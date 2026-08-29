'use client';

const API_BASE = '/api/v1';

function getStoredAccessToken(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem('accessToken');
}

function getStoredRefreshToken(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem('refreshToken');
}

let accessToken: string | null = null;
let refreshToken: string | null = null;

export function initTokens() {
  accessToken = getStoredAccessToken();
  refreshToken = getStoredRefreshToken();
}

export function setTokens(access: string, refresh: string) {
  accessToken = access;
  refreshToken = refresh;
  localStorage.setItem('accessToken', access);
  localStorage.setItem('refreshToken', refresh);
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
}

export function getAccessToken() {
  return accessToken;
}

// ──────────────────────────────────────────────────────────────────────────────
// Single-flight refresh token
//
// Backend merotasi refresh token: session lama dihapus, session baru dibuat.
// Artinya satu refresh token hanya sah SEKALI. Sebelum ada penjaga ini, tiap
// permintaan yang kena 401 memanggil refresh-nya sendiri — dan halaman yang
// menembak beberapa endpoint sekaligus (mis. Promise.all) memicu beberapa
// refresh berbarengan dengan token yang sama. Yang tercepat menang; sisanya
// memakai token yang sudah dirotasi, gagal, lalu memanggil clearTokens() dan
// melempar pengguna ke halaman login tanpa sebab yang terlihat. Di sisi server
// balapan yang sama memunculkan P2025 pada session.delete().
//
// Dengan menyimpan promise yang sedang berjalan, semua pemanggil berbarengan
// menunggu SATU proses refresh yang sama dan sama-sama memakai hasilnya.
// ──────────────────────────────────────────────────────────────────────────────
let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

async function refreshAccessToken(): Promise<boolean> {
  // Sudah ada refresh berjalan → ikut menunggu hasilnya, jangan memulai yang baru.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = performRefresh().finally(() => {
    // Dilepas di `finally` supaya percobaan berikutnya tetap bisa jalan
    // walaupun yang ini gagal.
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export async function apiRequest<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  let res = await fetch(url, { ...options, headers });

  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      // Baca accessToken SETELAH refresh selesai — kalau permintaan ini ikut
      // menumpang refresh milik pemanggil lain, token barunya sudah terpasang
      // di variabel modul oleh setTokens().
      headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetch(url, { ...options, headers });
    } else {
      clearTokens();
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: 'Request failed' } }));
    throw new Error(error.error?.message || `HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Unggah file lewat multipart/form-data.
 *
 * Tidak bisa memakai apiRequest() karena helper itu SELALU memasang
 * `Content-Type: application/json`. Untuk multipart, header itu justru harus
 * DIBIARKAN KOSONG — browser yang menyusunnya sendiri lengkap dengan boundary
 * pemisah. Memasangnya manual membuat server tidak bisa memisahkan bagian file.
 *
 * Penanganan 401 dan refresh token tetap sama, memakai single-flight yang sama.
 */
export async function apiUpload<T = any>(endpoint: string, form: FormData): Promise<T> {
  const url = `${API_BASE}${endpoint}`;

  const send = () => {
    const headers: Record<string, string> = {};
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    return fetch(url, { method: 'POST', headers, body: form });
  };

  let res = await send();

  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      res = await send();
    } else {
      clearTokens();
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: 'Upload gagal' } }));
    throw new Error(error.error?.message || `HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Ambil berkas biner (gambar katalog) sebagai object URL — Fase 89.
 *
 * `<img src="/api/v1/katalog/gambar/x.jpg">` TIDAK bisa dipakai: token akses
 * disimpan di localStorage dan dikirim lewat header `Authorization`, sedangkan
 * peramban tidak memasang header apa pun saat memuat `<img>`. Jadi gambarnya
 * harus diambil lewat fetch ber-header, baru hasilnya dijadikan object URL.
 *
 * ⚠️ Pemanggil WAJIB `URL.revokeObjectURL()` saat komponennya dilepas. Object URL
 * menahan blob-nya di memori sampai dibatalkan — riwayat chat panjang yang
 * digulir berkali-kali akan menumpuk gambar yang tidak pernah dilepas.
 *
 * Penanganan 401 + refresh single-flight sama dengan apiRequest/apiUpload.
 */
export async function apiGetObjectUrl(endpoint: string): Promise<string> {
  const url = `${API_BASE}${endpoint}`;

  const send = () => {
    const headers: Record<string, string> = {};
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    return fetch(url, { headers });
  };

  let res = await send();

  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      res = await send();
    } else {
      clearTokens();
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  return URL.createObjectURL(await res.blob());
}

export function apiGet<T = any>(endpoint: string) {
  return apiRequest<T>(endpoint);
}

export function apiPost<T = any>(endpoint: string, data?: any) {
  return apiRequest<T>(endpoint, {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  });
}

/**
 * [2026-08-25] Langkah A (redesign UX Global Agent Workspace) -- POST yang mengembalikan
 * Response MENTAH (streaming text/event-stream), BUKAN JSON yang sudah di-parse macam
 * apiPost/apiRequest. Dipakai Agent Workspace (/ai-ads/global-chat) yang balasannya SSE
 * progresif (event conversation_id/delta/done/error), bukan satu blok JSON di akhir.
 * Penanganan 401 + refresh single-flight sama seperti apiRequest -- bedanya retry HARUS
 * terjadi SEBELUM body mulai dibaca sbg stream (begitu reader.read() jalan, tidak bisa
 * "diulang" lagi kalau ternyata 401).
 */
export async function apiPostStream(endpoint: string, data?: any): Promise<Response> {
  const url = `${API_BASE}${endpoint}`;
  const send = () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    return fetch(url, { method: 'POST', headers, body: data ? JSON.stringify(data) : undefined });
  };

  let res = await send();

  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      res = await send();
    } else {
      clearTokens();
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: 'Request failed' } }));
    throw new Error(error.error?.message || `HTTP ${res.status}`);
  }

  return res;
}

export function apiPatch<T = any>(endpoint: string, data?: any) {
  return apiRequest<T>(endpoint, {
    method: 'PATCH',
    body: data ? JSON.stringify(data) : undefined,
  });
}

export function apiDelete<T = any>(endpoint: string) {
  return apiRequest<T>(endpoint, { method: 'DELETE' });
}

initTokens();
export function apiPut<T = any>(endpoint: string, data?: any) { return apiRequest<T>(endpoint, { method: 'PUT', body: data ? JSON.stringify(data) : undefined }); }
