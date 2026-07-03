'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Practice mode is now Zen mode — keep old links working.
export default function PracticeRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/zen');
  }, [router]);
  return null;
}
