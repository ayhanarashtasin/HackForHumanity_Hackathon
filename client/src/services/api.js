// `import.meta.env` only exists under Vite; the tests run these modules in Node.
const env = import.meta.env ?? {};
const apiUrl = (env.VITE_API_URL || '/api').replace(/\/$/, '');
// The alert and admin cookies must travel with API requests; a separate API origin needs them explicitly.
const credentials = env.VITE_API_URL ? 'include' : 'same-origin';

export async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, { credentials, ...options });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Cannot reach the API. Check that the backend is running.');
  }

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => {
    throw new Error('The API returned an unexpected response. Check the backend connection.');
  });

  if (!response.ok) {
    // `status` lets callers tell "not signed in" (401) from a failure; `details` carries field-level form errors (a map of field -> code).
    const error = new Error(payload.message || 'The request failed. Please try again.');
    error.status = response.status;
    error.details = payload.errors;
    throw error;
  }

  return payload.data;
}
