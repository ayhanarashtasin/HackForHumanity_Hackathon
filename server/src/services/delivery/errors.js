// An outbound send that did not go out. `kind` tells the queue what to do next:
//   retry      temporary (network, 5xx, provider rate limit): try again later
//   permanent  this message can never be delivered (rejected request): stop
//   blocked    the person blocked the bot, opted out, or the number is not reachable: stop and unlink the channel
//   auth       our own credentials were rejected: stop; the operator has to fix the configuration
// Messages never contain a URL, a token, a phone number or a message body: they are stored and shown to the administrator.
export class ChannelError extends Error {
  constructor(kind, message, { retryAfterMs = null, code = null } = {}) {
    super(message);
    this.name = 'ChannelError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

export const isRetryable = (error) => error instanceof ChannelError && error.kind === 'retry';
