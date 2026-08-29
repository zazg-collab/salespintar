'use client';

/**
 * globalAgentBus — jembatan event ringan (CustomEvent di `window`) supaya komponen yang jauh
 * dari GlobalAgentWidget di pohon React (mis. CampaignAuditModal di meta-capi-dashboard) bisa
 * "buka widget + suntik pesan pembuka" tanpa perlu prop-drilling atau context provider baru.
 *
 * Bagian dari Langkah C blueprint "Ekstensi Fase 3: Global Agent Workspace & Multi-BM Token
 * Vault" v1.3 -- menghubungkan tombol "lanjut ngobrol" di modal Audit AI ke widget global
 * (Langkah B). Widget yang menangkap event ini akan buka otomatis lalu mengirim `text` sebagai
 * pesan pertama ke thread PIC yang SEDANG AKTIF di widget (kalau belum ada PIC terpilih, pesan
 * ditahan dulu sampai user memilih PIC, baru otomatis terkirim) -- tidak ada logika PIC/ID
 * khusus di sisi pemanggil, cukup teksnya saja.
 */

const EVENT_NAME = 'salespintar:global-agent-inject';

export function openGlobalAgentWithMessage(text: string) {
  if (typeof window === 'undefined' || !text) return;
  window.dispatchEvent(new CustomEvent<string>(EVENT_NAME, { detail: text }));
}

export function onGlobalAgentInject(handler: (text: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<string>).detail;
    if (typeof detail === 'string' && detail) handler(detail);
  };
  window.addEventListener(EVENT_NAME, listener as EventListener);
  return () => window.removeEventListener(EVENT_NAME, listener as EventListener);
}
