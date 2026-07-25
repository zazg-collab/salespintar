'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AppHome() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/app/dashboard');
  }, [router]);

  return null;
}
