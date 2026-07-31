export function activate(api) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: true });
  api.overlay.appendChild(canvas);

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const storedDensity = Number(api.storage.get('density', 72));
  const starCount = Math.max(24, Math.min(160, Number.isFinite(storedDensity) ? storedDensity : 72));
  const stars = Array.from({ length: starCount }, (_, index) => ({
    x: ((index * 83) % 101) / 101,
    y: ((index * 47) % 97) / 97,
    radius: 0.45 + ((index * 13) % 11) / 8,
    phase: (index * 0.71) % (Math.PI * 2),
  }));

  let frame = 0;
  let animationFrame = 0;
  let disposed = false;

  function resize() {
    const scale = Math.min(devicePixelRatio, 2);
    canvas.width = Math.max(1, Math.floor(innerWidth * scale));
    canvas.height = Math.max(1, Math.floor(innerHeight * scale));
    context?.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function render(time = 0) {
    if (!context || disposed) return;
    context.clearRect(0, 0, innerWidth, innerHeight);
    for (const star of stars) {
      const alpha = reducedMotion.matches
        ? 0.32
        : 0.2 + (Math.sin(time / 900 + star.phase) + 1) * 0.18;
      context.beginPath();
      context.fillStyle = `rgba(188, 224, 255, ${alpha})`;
      context.arc(star.x * innerWidth, star.y * innerHeight, star.radius, 0, Math.PI * 2);
      context.fill();
    }
    frame += 1;
    if (!reducedMotion.matches || frame === 1) animationFrame = requestAnimationFrame(render);
  }

  const stopState = api.events.on('state', (state) => {
    document.documentElement.dataset.makaSkinStreaming = String(state.streaming);
  });
  addEventListener('resize', resize);
  resize();
  render();
  api.log('Neon Orbit activated with', starCount, 'stars');

  return () => {
    disposed = true;
    cancelAnimationFrame(animationFrame);
    removeEventListener('resize', resize);
    stopState();
    document.documentElement.removeAttribute('data-maka-skin-streaming');
  };
}
