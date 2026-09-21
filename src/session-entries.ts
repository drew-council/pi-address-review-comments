interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

export function latestCustomEntryData<T>(entries: readonly SessionEntryLike[], customType: string): T | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === customType) return entry.data as T | undefined;
  }
  return undefined;
}
