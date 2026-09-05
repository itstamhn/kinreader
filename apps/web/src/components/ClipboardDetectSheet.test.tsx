import React from 'react';
import { test, expect, afterEach } from 'bun:test';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { ClipboardDetectSheet } from './ClipboardDetectSheet';
afterEach(cleanup);
test('clipboard submits to the shared creator with no extraction or invented metadata', () => {
  let input: unknown;
  render(<ClipboardDetectSheet isOpen detectedUrl="https://x.com/user/status/123" onClose={() => {}} onCreate={value => { input = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create audio' }));
  expect(input).toEqual({ sourceUrl: 'https://x.com/user/status/123' });
  expect(screen.queryByText(/Thread detected|9 min/)).toBeNull();
});
test('dismissal before submission does not create anything', () => {
  let count = 0;
  render(<ClipboardDetectSheet isOpen detectedUrl="https://example.com" onClose={() => {}} onCreate={() => { count++; }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); expect(count).toBe(0);
});
