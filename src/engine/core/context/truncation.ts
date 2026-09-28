const MAX_OBSERVATION_CHARS = 12 * 1024;

export function truncateObservation(observation: string, maxChars = MAX_OBSERVATION_CHARS): string {
  if (observation.length <= maxChars) return observation;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return observation.slice(0, head) + "\n... (truncated " + (observation.length - maxChars) + " chars, use a narrower tool query) ...\n" + observation.slice(-tail);
}
