export const criticalKey = (item) => `${item.id}:${item.renotifications ?? 0}`;

// An optimistic read belongs to this version of the alert, not every future development in its episode.
export function withOptimisticRead(item, reads) {
  const read = reads[item.id];
  return read && !item.readAt && read.stage === (item.renotifications ?? 0) && read.severity === item.severity
    ? { ...item, readAt: read.at } : item;
}

export const optimisticRead = (item, at) => ({ at, stage: item.renotifications ?? 0, severity: item.severity });
