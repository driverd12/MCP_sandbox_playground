export function truncate(value: string, max = 2000): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

export function logEvent(event: string, details: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...details,
  };
  console.error(JSON.stringify(payload));
}
