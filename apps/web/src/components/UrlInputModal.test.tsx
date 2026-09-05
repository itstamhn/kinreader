import React from 'react';
import { test, expect, afterEach } from 'bun:test';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { UrlInputModal } from './UrlInputModal';
afterEach(cleanup);
test('form submits a normalized link and closes without extracting in the component', () => {
  let submitted: unknown; let closed = false;
  render(<UrlInputModal isOpen onClose={() => { closed = true; }} onCreate={input => { submitted = input; }} />);
  fireEvent.change(screen.getByLabelText('Article link'), { target: { value: 'example.com/article' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create audio' }));
  expect(submitted).toEqual({ sourceUrl: 'https://example.com/article' }); expect(closed).toBe(true);
  expect(screen.queryByText(/3,120|14 min|Thread detected/)).toBeNull();
});
test('pasted text retains paragraphs and punctuation', () => {
  let submitted: unknown;
  render(<UrlInputModal isOpen onClose={() => {}} onCreate={input => { submitted = input; }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Paste text' }));
  fireEvent.change(screen.getByLabelText('Article text'), { target: { value: 'C# and user_id.\n\nNext paragraph.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create audio' }));
  expect(submitted).toEqual({ content: 'C# and user_id.\n\nNext paragraph.', title: undefined });
});
test('oversized content stays in the form with a clear error before submission', () => {
  let calls = 0;
  render(<UrlInputModal isOpen onClose={() => {}} onCreate={() => { calls++; }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Paste text' }));
  fireEvent.change(screen.getByLabelText('Article text'), { target: { value: 'x'.repeat(150001) } });
  fireEvent.click(screen.getByRole('button', { name: 'Create audio' }));
  expect(screen.getByRole('alert').textContent).toContain('150,000'); expect(calls).toBe(0);
});
