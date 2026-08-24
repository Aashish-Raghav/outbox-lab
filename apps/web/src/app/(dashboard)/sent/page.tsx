import { EmailList } from '@/features/emails/EmailList';

export default function SentPage() {
  return <EmailList mailbox="sent" title="Sent" />;
}
