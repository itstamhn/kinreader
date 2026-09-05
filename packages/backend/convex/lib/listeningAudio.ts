/** Serve saved segments without exposing a permanent storage URL. */
export function listeningAudioResponse(blob: Blob, range: string | null, head = false): Response {
  const headers = new Headers({ 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
  const invalidRange = () => { headers.set('Content-Range', `bytes */${blob.size}`); return new Response(null, { status: 416, headers }); };
  let start = 0, end = blob.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return invalidRange();
    start = match[1] ? Number(match[1]) : Math.max(0, blob.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
    if (start > end || start >= blob.size) return invalidRange();
    headers.set('Content-Range', `bytes ${start}-${end}/${blob.size}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  return new Response(head ? null : blob.slice(start, end + 1), { status: range ? 206 : 200, headers });
}
