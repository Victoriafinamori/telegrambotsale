// Calendar month in the merchant platform's business timezone, clamped at month end.
export function nextBillingMonth(start: Date, months = 1): Date {
  if (!Number.isInteger(months) || months < 1 || months > 120)
    throw Error('Invalid billing period');
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = (date: Date) =>
    Object.fromEntries(
      format
        .formatToParts(date)
        .filter((v) => v.type !== 'literal')
        .map((v) => [v.type, Number(v.value)]),
    );
  const p = parts(start),
    absoluteMonth = p.year * 12 + p.month - 1 + months,
    month = absoluteMonth % 12,
    year = Math.floor(absoluteMonth / 12);
  const day = Math.min(p.day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  const target = Date.UTC(year, month, day, p.hour, p.minute, p.second, start.getUTCMilliseconds());
  let candidate = target;
  for (let i = 0; i < 3; i++) {
    const q = parts(new Date(candidate));
    const offset =
      Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) -
      (candidate - start.getUTCMilliseconds());
    candidate = target - offset;
  }
  return new Date(candidate);
}
