import { expect, test } from 'bun:test';
import { articleCacheKey } from './articleCacheKey';

test('uses a real source URL without hashing it', async () => {
  expect(
    await articleCacheKey({
      sourceUrl: '  https://example.com/article  ',
      content: 'Content does not replace a real URL identity',
    })
  ).toBe('https://example.com/article');
});

test('uses the SHA-256 of pasted content so titles cannot collide', async () => {
  const first = await articleCacheKey({ content: 'Exact timing' });
  const same = await articleCacheKey({ content: 'Exact timing' });
  const different = await articleCacheKey({ content: 'Second note' });

  expect(first).toBe(
    'content-sha256:b2d0149d4df84e1408ed3208160aa121666399f06ebc62f7636aaeac1d329fb6'
  );
  expect(same).toBe(first);
  expect(different).not.toBe(first);
});
