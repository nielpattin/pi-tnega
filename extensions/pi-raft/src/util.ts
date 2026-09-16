export const countNewlines = (value: string): number => {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 10) count++;
  }
  return count;
};

export const truncateMiddle = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  const marker = `\n\n... ${value.length - maxChars} characters omitted by Pi Raft ...\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
};

export const stringifyUnknown = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  if (typeof value === "symbol") return value.toString();
  if (value instanceof Error) return value.message;
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? "<unserializable>";
  } catch {
    return "<unserializable>";
  }
};
