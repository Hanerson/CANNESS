export function newGenerationId(uuid: string): string {
  return `gen-${uuid.replaceAll('-', '').slice(0, 8)}`
}
