'use client';

import { useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccessToken } from '../lib/api';

type EventHandler = (data: any) => void;

const listeners = new Map<string, Set<EventHandler>>();

let socket: Socket | null = null;

export function useWebSocket() {
  const isConnected = useRef(false);

  useEffect(() => {
    if (socket?.connected) return;

    const token = getAccessToken();
    if (!token) return;

    socket = io('/', {
      query: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => {
      isConnected.current = true;
    });

    socket.on('disconnect', () => {
      isConnected.current = false;
    });

    socket.on('connect_error', (err) => {
      console.error('WebSocket connection error:', err.message);
    });

    socket.on('ping', () => {
      socket?.emit('pong');
    });

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

  return { on, off, isConnected: isConnected.current };
}

export function getSocket(): Socket | null {
  return socket;
}
