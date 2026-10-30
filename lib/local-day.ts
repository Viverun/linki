/**
 * Local-calendar-day arithmetic for per-account daily limits.
 *
 * Daily sending limits are configured per account and are meant to mean "today in
 * that account's timezone": the working-hours window already runs on the account's
 * local clock, so the quota must roll over at the same midnight. Counting against
 * UTC days (`date('now')`) instead meant a non-UTC account had two overlapping
 * partial days and could send up to double its configured limit, silently.
 *
 * The helpers here convert a local calendar day to an absolute UTC interval, so
 * SQL can use a half-open range (`>= start AND < end`) with no per-row timezone
 * conversion. That keeps the queries indexable and puts all timezone reasoning in
 * one reviewed place.
 */

/** A timezone string that Intl accepts, or UTC. Invalid input must not throw at runtime. */
export function safeTimeZone(timezone: string | null | undefined): string {
  if (!timezone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return "UTC";
  }
}

export interface LocalDayWindow {
  /** First instant of the local day (inclusive), as an absolute UTC instant. */
  start: Date;
  /** First instant of the next local day (exclusive), as an absolute UTC instant. */
  end: Date;
  /** The local calendar date, YYYY-MM-DD. */
  key: string;
}

/**
 * Convert a wall-clock time in `timezone` to the UTC instant it denotes.
 *
 * The offset is unknown until the instant is known, so this iterates a fixed point:
 * format the guess in the target zone, measure how far the formatted wall clock is
 * from the requested one, and shift by that difference. Three passes is enough for
 * every real zone, including the 30/45-minute offsets and both DST directions.
 */
export function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const tz = safeTimeZone(timezone);
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(guess);

    const get = (type: string) =>
      parts.find(p => p.type === type)?.value ?? "0";

    const localAsUtc = Date.UTC(
      parseInt(get("year"), 10),
      parseInt(get("month"), 10) - 1,
      parseInt(get("day"), 10),
      parseInt(get("hour"), 10) % 24,
      parseInt(get("minute"), 10),
      parseInt(get("second"), 10),
    );

    const offset = localAsUtc - guess.getTime();
    guess = new Date(
      Date.UTC(year, month - 1, day, hour, minute, 0) - offset
    );
  }

  return guess;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function zonedDateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string): number =>
    parseInt(parts.find(p => p.type === type)?.value ?? "0", 10);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * The local calendar day containing `now`, expressed as UTC bounds.
 *
 * The end is computed as the start of the *next* local date rather than
 * `start + 24h`, so a DST day is honestly 23 or 25 hours long. Queries must use
 * `>= start AND < end`.
 */
export function localDayWindow(
  timezone: string | null | undefined,
  now: Date = new Date()
): LocalDayWindow {
  const tz = safeTimeZone(timezone);
  const { year, month, day } = zonedDateParts(now, tz);
  return {
    start: zonedDateTimeToUtc(year, month, day, 0, 0, tz),
    // Date.UTC rolls day+1 over month and year boundaries for us.
    end: zonedDateTimeToUtc(year, month, day + 1, 0, 0, tz),
    key: `${year}-${pad2(month)}-${pad2(day)}`,
  };
}

/** The local calendar date (YYYY-MM-DD) containing `now`. */
export function localDayKey(
  timezone: string | null | undefined,
  now: Date = new Date()
): string {
  return localDayWindow(timezone, now).key;
}
