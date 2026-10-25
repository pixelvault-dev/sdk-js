/** Thrown for every non-2xx API response and for network failures. */
export class PixelVaultError extends Error {
  /** HTTP status, or 0 when the request never got a response. */
  readonly status: number;
  /** Machine-readable code from the API, e.g. `upload_limit_reached`. */
  readonly code: string;
  /** Seconds to wait before retrying, when the API sent `Retry-After`. */
  readonly retryAfter?: number;

  constructor(
    message: string,
    status: number,
    code: string,
    retryAfter?: number
  ) {
    super(message);
    this.name = "PixelVaultError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
