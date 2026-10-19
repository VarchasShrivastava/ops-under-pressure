import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }

  return value;
}

export function requestHash(
  method: string,
  path: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalize({
          method: method.toUpperCase(),
          path,
          body,
        }),
      ),
    )
    .digest('hex');
}
