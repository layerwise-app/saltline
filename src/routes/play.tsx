import { createFileRoute } from '@tanstack/react-router';
import { SaltlinePlayer } from '~/components/SaltlinePlayer';
import { seo } from '~/utils/seo';

export const Route = createFileRoute('/play')({
  head: () => seo({ title: 'Play Saltline', description: 'Saltline browser FPS.', noindex: true }),
  component: SaltlinePlayer,
});
