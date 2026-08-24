import type { Metadata } from 'next';
import { LoginCard } from '@/features/auth/LoginCard';

export const metadata: Metadata = { title: 'Login — ReachInbox' };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-soft px-5 py-10">
      <LoginCard />
    </main>
  );
}
