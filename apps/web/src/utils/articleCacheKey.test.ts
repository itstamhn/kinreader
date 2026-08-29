import { expect, test } from 'bun:test';
import { articleCacheKey } from './articleCacheKey';

test('keys a source URL by both the URL and the full-content SHA-256', async () => {
  const first = await articleCacheKey({
    sourceUrl: '  https://example.com/article  ',
    content: 'Content does not replace a real URL identity',
  });
  const same = await articleCacheKey({
    sourceUrl: 'https://example.com/article',
    content: 'Content does not replace a real URL identity',
  });
  const changed = await articleCacheKey({
    sourceUrl: 'https://example.com/article',
    content: 'Changed content at same URL',
  });

  expect(first).toBe(
    'source-sha256:632538290468e7a39c06323c9e3ae98f31072d641cbb37ea37917f56bbeb5539:content-sha256:124022a83a591351b38e13c84a1b743ad120e92acd08004b8ce4840f4487879e'
  );
  expect(same).toBe(first);
  expect(changed).toBe(
    'source-sha256:632538290468e7a39c06323c9e3ae98f31072d641cbb37ea37917f56bbeb5539:content-sha256:4879d149681310e545a118a945742dad29bcdf7d37d1f53ea7208b26d133fc58'
  );
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
