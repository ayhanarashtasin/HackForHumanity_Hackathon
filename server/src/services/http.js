export async function withRetry(task, { attempts = 3, baseDelayMs = 1500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

// Runs async tasks with a fixed number of workers, keeping result order.
export async function mapWithConcurrency(items, concurrency, task) {
  const results = new Array(items.length);
  let next = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }));

  return results;
}
