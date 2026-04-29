function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function pad3(value: number): string {
  return String(value).padStart(3, '0');
}

export function formatLocalIso(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absOffset / 60);
  const offsetRemainderMinutes = absOffset % 60;

  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
    `.${pad3(date.getMilliseconds())}${sign}${pad2(offsetHours)}:${pad2(offsetRemainderMinutes)}`,
  ].join('');
}

export function formatLocalHourIso(date: string, hour: number): string {
  const [yearRaw, monthRaw, dayRaw] = date.split('-');
  const year = Number.parseInt(yearRaw ?? '', 10);
  const month = Number.parseInt(monthRaw ?? '', 10);
  const day = Number.parseInt(dayRaw ?? '', 10);

  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day) || !Number.isInteger(hour)) {
    return `${date}T${pad2(hour)}:00:00`;
  }

  return formatLocalIso(new Date(year, month - 1, day, hour, 0, 0, 0));
}
