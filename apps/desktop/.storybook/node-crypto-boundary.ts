export function createHash(): never {
  throw new Error('Node crypto is unavailable in the Storybook browser preview');
}
