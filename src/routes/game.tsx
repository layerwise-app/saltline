import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { seo } from '~/utils/seo';
import fontsCss from '~/game/styles/fonts.css?url';
import gameCss from '~/game/styles/game.css?url';

/**
 * Full-screen game document. The landing page embeds it in an iframe, which
 * gives the game its own window (pointer lock, audio, rAF loop) and tears all
 * of it down when the player closes the frame.
 */
export const Route = createFileRoute('/game')({
  head: () => {
    const meta = seo({
      title: 'Saltline — Play',
      description: 'Saltline browser FPS.',
      noindex: true
    });
    return {
      ...meta,
      links: [
        ...meta.links,
        { rel: 'stylesheet', href: fontsCss },
        { rel: 'stylesheet', href: gameCss }
      ]
    };
  },
  component: GamePage
});

function GamePage() {
  useEffect(() => {
    let cancelled = false;
    // The boot line is rendered on the server in English; switch it to the player's language.
    void import('~/game/i18n').then(({ t }) => {
      const bootMsg = document.getElementById('boot-msg');
      if (bootMsg && !cancelled) bootMsg.textContent = t('boot.raising');
    });
    void import('~/game/main').then(({ startSaltline }) => {
      if (!cancelled) startSaltline();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div id="app">
      <canvas id="view" tabIndex={0} />
      <div id="ui" />
      <div id="boot">
        <div className="boot-mark">Saltline</div>
        <div className="boot-sub" id="boot-msg">
          Raising the terminal
        </div>
        <div className="boot-bar">
          <i id="boot-fill" />
        </div>
      </div>
    </div>
  );
}
