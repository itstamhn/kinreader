/** Limits are listening seconds, converted to the media clock at this speed. */
export function continuousBufferPolicy(rate: number) {
  return { ahead: 90 * rate, behind: 30 * rate };
}
