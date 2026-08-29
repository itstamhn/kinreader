import { test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

test('convex layout separates functions root from lib and shared', () => {
  const configPath = resolve(__dirname, '../convex.json');
  expect(existsSync(configPath)).toBe(true);

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(config.functions).toBe('convex/functions');
  expect(config.codegen?.staticApi).toBe(true);
  expect(config.codegen?.staticDataModel).toBe(true);

  // Assert lib/ and shared/ exist outside the functions root
  const functionsDir = resolve(__dirname, 'functions');
  const libDir = resolve(__dirname, 'lib');
  const sharedDir = resolve(__dirname, 'shared');

  expect(existsSync(functionsDir)).toBe(true);
  expect(existsSync(libDir)).toBe(true);
  expect(existsSync(sharedDir)).toBe(true);

  // Confirm lib and shared are NOT subdirectories of functions
  expect(libDir.startsWith(functionsDir)).toBe(false);
  expect(sharedDir.startsWith(functionsDir)).toBe(false);
});
