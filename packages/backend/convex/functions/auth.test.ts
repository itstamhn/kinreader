import { expect, test } from 'bun:test';
import authDefinition from './auth';

test('magic links remain valid for the 15 minutes promised by the email', () => {
  const options = authDefinition({} as never);
  const magicLinkPlugin = options.plugins?.find((plugin) => plugin.id === 'magic-link');

  expect(magicLinkPlugin?.options?.expiresIn).toBe(15 * 60);
});
