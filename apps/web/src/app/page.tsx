import { redirect } from 'next/navigation';

/**
 * `/` has no content of its own.
 *
 * Whether the visitor lands on the mailbox or the login screen depends on an
 * httpOnly cookie the dashboard layout already checks, so this just forwards
 * to the default tab and lets that guard decide.
 */
export default function HomePage() {
  redirect('/scheduled');
}
