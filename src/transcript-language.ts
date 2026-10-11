export function isArabicTranscript(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const arabic = text.match(/\p{Script=Arabic}/gu)?.length ?? 0;
  return arabic >= 8 && letters > 0 && arabic / letters >= 0.3;
}
