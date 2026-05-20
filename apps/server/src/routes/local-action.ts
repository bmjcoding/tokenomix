import type { Context } from 'hono';

export const LOCAL_ACTION_HEADER = 'X-Tokenomix-Local-Action';

export function hasLocalActionHeader(c: Context): boolean {
  return c.req.header(LOCAL_ACTION_HEADER) === '1';
}
