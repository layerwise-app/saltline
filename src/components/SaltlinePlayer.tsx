import '~/styles/saltline.css';

/** Full-page player: the game runs in its own document inside an iframe. */
export function SaltlinePlayer() {
  return (
    <main className="saltline-site">
      <h1 className="sr-only">Saltline</h1>
      <div className="game-frame">
        <iframe src="/game" title="Saltline" allow="fullscreen; autoplay; gamepad" allowFullScreen />
      </div>
    </main>
  );
}
