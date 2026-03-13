export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: any
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function toSafeError(e: unknown): { name: string; message: string; status?: number; body?: any } {
  if (e instanceof HttpError) {
    return { name: e.name, message: e.message, status: e.status, body: e.body };
  }
  if (e instanceof Error) {
    return { name: e.name, message: e.message };
  }
  return { name: "UnknownError", message: String(e) };
}
