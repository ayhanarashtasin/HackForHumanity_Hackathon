export function notFound(req, res) {
  res.status(404).json({ message: 'API route not found.' });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  let status = error.status || 500;
  let message = error.message;

  if (error.name === 'ValidationError' || error.name === 'CastError') {
    status = 400;
  } else if (error.code === 11000) {
    status = 409;
    message = 'A record with these values already exists.';
  } else if (error.type === 'entity.parse.failed') {
    status = 400;
    message = 'Request body must contain valid JSON.';
  } else if (error.type === 'entity.too.large') {
    status = 413;
    message = 'Request body is too large.';
  }

  if (status >= 500 && !error.expose) {
    console.error(error);
    message = 'Internal server error.';
  }

  // Field-level validation errors (a map of field path -> code) travel with a 400 so the form can mark the right answers.
  const body = { message };
  if (error.details && status < 500) body.errors = error.details;
  res.status(status).json(body);
}
