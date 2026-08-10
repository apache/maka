const timer = setInterval(() => undefined, 1_000);
process.once('SIGTERM', () => {
  clearInterval(timer);
});
