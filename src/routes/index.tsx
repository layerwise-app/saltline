import { createFileRoute } from '@tanstack/react-router';
import { SaltlinePlayer } from '~/components/SaltlinePlayer';
import { seo } from '~/utils/seo';

export const Route = createFileRoute('/')({
  head: () => seo({
    title: 'Saltline — Browser FPS',
    description: 'Enter the rain-soaked Saltline Terminal. Cut three uplinks and reach the boat, or survive endless waves in Holdout.',
    path: '/',
  }),
  component: SaltlinePlayer,
});
