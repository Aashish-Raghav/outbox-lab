import type { EmailJob } from '@reachinbox/shared';
import { EMAIL_STATUS } from '@reachinbox/shared';
import { Chip } from '@/components/ui';
import { AlertIcon, ClockIcon, SendIcon } from '@/components/icons';
import { formatScheduleChip } from '@/lib/format';

/**
 * The chip on the right-hand side of a list row.
 *
 * This is the one place the two mailbox tabs genuinely differ in the Figma —
 * amber `🕐 Tue 9:15:12 AM` while pending, flat grey `Sent` once delivered — so
 * it is a prop-driven chip rather than two list implementations.
 */
export function StatusChip({ email }: { email: EmailJob }) {
  switch (email.status) {
    case EMAIL_STATUS.SENT:
      return (
        <Chip tone="neutral" icon={<SendIcon className="text-[13px]" />}>
          Sent
        </Chip>
      );

    case EMAIL_STATUS.FAILED:
      return (
        <Chip tone="danger" icon={<AlertIcon className="text-[13px]" />}>
          Failed
        </Chip>
      );

    case EMAIL_STATUS.CANCELLED:
      return <Chip tone="muted">Cancelled</Chip>;

    case EMAIL_STATUS.PROCESSING:
      return <Chip tone="primary">Sending…</Chip>;

    // SCHEDULED and QUEUED both read as "waiting" to a user; the distinction is
    // an internal one about whether the delay has elapsed yet.
    default:
      return (
        <Chip tone="warning" icon={<ClockIcon className="text-[13px]" />}>
          {formatScheduleChip(email.scheduledAt)}
        </Chip>
      );
  }
}
