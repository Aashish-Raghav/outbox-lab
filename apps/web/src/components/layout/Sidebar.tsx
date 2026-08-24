'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { User } from '@reachinbox/shared';
import { Button } from '@/components/ui';
import { ClockIcon, PlusIcon, SendIcon } from '@/components/icons';
import { useStats } from '@/hooks/useStats';
import { cn } from '@/lib/format';
import { Logo } from './Logo';
import { UserMenu } from './UserMenu';

interface NavItem {
  href: string;
  label: string;
  icon: typeof ClockIcon;
  /** Which field of `/api/stats` supplies the count beside the label. */
  countKey: 'scheduled' | 'sent';
}

const NAV: NavItem[] = [
  { href: '/scheduled', label: 'Scheduled', icon: ClockIcon, countKey: 'scheduled' },
  { href: '/sent', label: 'Sent', icon: SendIcon, countKey: 'sent' },
];

export function Sidebar({ user }: { user: User }) {
  const pathname = usePathname();
  const router = useRouter();
  const stats = useStats();

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col gap-6 border-r border-line bg-white px-4 py-5">
      <Logo className="px-2" />

      <UserMenu user={user} />

      <Button
        variant="outline"
        fullWidth
        leftIcon={<PlusIcon className="text-base" />}
        onClick={() => router.push('/compose')}
      >
        Compose
      </Button>

      <nav aria-label="Mailboxes">
        <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
          Core
        </p>

        <ul className="space-y-1">
          {NAV.map(({ href, label, icon: Icon, countKey }) => {
            // `startsWith` so opening an email from a list keeps that tab lit.
            const active = pathname === href || pathname.startsWith(`${href}/`);
            const count = stats.data?.[countKey];

            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2.5 rounded-full px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-primary-soft font-semibold text-primary'
                      : 'text-ink hover:bg-neutral-soft',
                  )}
                >
                  <Icon className="shrink-0 text-base" />
                  <span className="flex-1">{label}</span>
                  {/* Undefined on first load — a `0` that flips to `785` reads
                      as a bug, so nothing is shown until the count is known. */}
                  {count !== undefined && (
                    <span
                      className={cn(
                        'text-xs tabular-nums',
                        active ? 'text-primary' : 'text-muted',
                      )}
                    >
                      {count}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Failed sends are not a mailbox in the Figma, but silently hiding them
          would make a broken SMTP config look like nothing happened. */}
      {stats.data && stats.data.failed > 0 && (
        <p className="mt-auto rounded-field bg-danger-soft px-3 py-2 text-xs text-danger">
          {stats.data.failed} failed {stats.data.failed === 1 ? 'send' : 'sends'} — see the Sent
          tab.
        </p>
      )}
    </aside>
  );
}
