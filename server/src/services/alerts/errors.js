// An error the API can show to the client as it is (the global error handler reads `status`, `message` and `details`).
export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    if (details) this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const unauthorized = (message = 'Not signed in.') => new HttpError(401, message);
export const notFound = (message = 'Not found.') => new HttpError(404, message);

// A 5xx the person should be told about in plain words (a channel that is not set up, a code that could not be sent). The global handler
// hides the message of every other 5xx, because those are bugs and may carry internals.
export const serviceUnavailable = (message, status = 503) => Object.assign(new HttpError(status, message), { expose: true });
