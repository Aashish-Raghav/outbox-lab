import { EmailList } from '@/features/emails/EmailList';

export default function ScheduledPage() {
  return <EmailList mailbox="scheduled" title="Scheduled" />;
}
