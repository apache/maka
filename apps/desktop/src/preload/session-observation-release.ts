interface SessionObservationDispatch {
  readonly completion: Promise<unknown>;
}

export async function releaseSessionObservation(
  dispatch: Promise<SessionObservationDispatch>,
  release: () => Promise<unknown>,
): Promise<void> {
  const { completion } = await dispatch;
  await release().catch(() => undefined);
  await completion.catch(() => undefined);
  await release().catch(() => undefined);
}
