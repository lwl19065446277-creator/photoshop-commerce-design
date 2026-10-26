export class StudioError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
export function errorData(error: unknown) {
  if (error instanceof StudioError) return { code: error.code, message: error.message, details: error.details };
  if (error instanceof Error) return { code: 'INTERNAL_ERROR', message: error.message };
  return { code: 'INTERNAL_ERROR', message: String(error) };
}
