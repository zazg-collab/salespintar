'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccessToken } from '../lib/api';

type EventHandler = (data: any) => void;

const listeners = new Map<string, Set<EventHandler>>();

let socket: Socket | null = null;

// ──────────────────────────────────────────────────────────────────────────────
// STATUS SAMBUNGAN YANG BISA DIPANTAU KOMPONEN — Fase 80
//
// Sampai fase ini status sambungan cuma disimpan di `useRef`, yang TIDAK memicu
// render ulang — jadi tidak ada komponen yang bisa bereaksi saat socket putus
// atau tersambung lagi. Padahal justru saat tersambung LAGI-lah kita tahu pasti
// ada event yang terlewat selama putus, dan data di layar sudah basi.
//
// Di laptop hal ini nyaris tidak pernah terasa: socket menempel ke
// `localhost:3000` dan praktis tidak pernah putus. Lewat internet ia putus
// karena hal biasa — laptop tidur, ganti wifi, server di-deploy ulang. Yang
// dulu "tidak mungkin terjadi" jadi kejadian sehari-hari.
// ──────────────────────────────────────────────────────────────────────────────
const statusListeners = new Set<(tersambung: boolean) => void>();
function siarkanStatus(tersambung: boolean) {
  statusListeners.forEach((f) => f(tersambung));
}

export function useWebSocket() {
  const isConnected = useRef(false);
  const [connected, setConnected] = useState<boolean>(socket?.connected ?? false);

  useEffect(() => {
    statusListeners.add(setConnected);
    setConnected(socket?.connected ?? false);
    return () => { statusListeners.delete(setConnected); };
  }, []);

  useEffect(() => {
    if (socket?.connected) return;

    const token = getAccessToken();
    if (!token) return;

    // Bypass Next.js proxy di local development karena sering menyebabkan timeout pada koneksi WebSocket
    const socketUrl = process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : '/';
    socket = io(socketUrl, {
      // ── Fix A6: Gunakan auth (tidak masuk URL/log) bukan query (masuk URL plaintext) ─────
      auth: { token },
      // ────────────────────────────────────────────────────────────────────────────────────────
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => {
      isConnected.current = true;
      siarkanStatus(true);
      // ── Fix C7: Replay semua listeners setelah connect/reconnect ─────────────────────────
      // Tanpa ini, handler yang di-register sebelum socket terhubung tidak akan
      // aktif karena socket.on() dipanggil sebelum socket ready.
      listeners.forEach((handlers, event) => {
        handlers.forEach(handler => socket?.on(event, handler));
      });
      // ──────────────────────────────────────────────────────────────────────────────────────
    });

    socket.on('disconnect', () => {
      isConnected.current = false;
      siarkanStatus(false);
    });

    socket.on('connect_error', (err) => {
      console.error('WebSocket connection error:', err.message);
    });

    // Fix C3: Hapus manual ping/pong — socket.io menangani heartbeat secara internal
    // socket.on('ping', () => socket?.emit('pong')); // ← DIHAPUS (redundan)

    return () => {
      if (socket) {
        socket.close();
        socket = null;
      }
    };
  }, []);

  const on = useCallback((event: string, handler: EventHandler) => {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event)!.add(handler);

    if (socket) {
      socket.on(event, handler);
    }

    return () => {
      listeners.get(event)?.delete(handler);
      socket?.off(event, handler);
    };
  }, []);

  const off = useCallback((event: string, handler: EventHandler) => {
    listeners.get(event)?.delete(handler);
    socket?.off(event, handler);
  }, []);

  // `isConnected` dipertahankan apa adanya supaya pemakai lama tidak patah, tapi
  // ia berasal dari ref — nilainya tidak memicu render. `connected` yang reaktif.
  return { on, off, isConnected: isConnected.current, connected };
}

export function getSocket(): Socket | null {
  return socket;
}
