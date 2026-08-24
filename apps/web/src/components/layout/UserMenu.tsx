'use client';

import type { User } from '@reachinbox/shared';
import { Avatar, Popover } from '@/components/ui';
import { ChevronDownIcon, LogoutIcon } from '@/components/icons';
import { useLogout } from '@/hooks/useAuth';
import { cn } from '@/lib/format';

/**
 * The sidebar identity chip: avatar, name, email, chevron — and the Logout
 * action the assignment asks for, in the menu behind it.
 */
export function UserMenu({ user }: { user: User }) {
  const logout = useLogout();

  return (
    <Popover
      className="w-[248px]"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={cn(
            'flex w-full items-center gap-2.5 rounded-field p-2 text-left transition-colors',
            open ? 'bg-neutral-soft' : 'hover:bg-neutral-soft',
          )}
        >
          <Avatar name={user.name} email={user.email} src={user.avatarUrl} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold text-ink">
              {user.name}
            </span>
            <span className="block truncate text-[11px] text-muted">{user.email}</span>
          </span>
          <ChevronDownIcon
            className={cn('shrink-0 text-sm text-muted transition-transform', open && 'rotate-180')}
          />
        </button>
      )}
    >
      {() => (
        <div>
          <div className="flex items-center gap-3 border-b border-line pb-3">
            <Avatar name={user.name} email={user.email} src={user.avatarUrl} size="md" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{user.name}</p>
              <p className="truncate text-xs text-muted">{user.email}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className={cn(
              'mt-2 flex w-full items-center gap-2.5 rounded-field px-2 py-2',
              'text-sm text-ink transition-colors hover:bg-neutral-soft',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            <LogoutIcon className="text-base text-muted" />
            {logout.isPending ? 'Signing out…' : 'Logout'}
          </button>
        </div>
      )}
    </Popover>
  );
}
