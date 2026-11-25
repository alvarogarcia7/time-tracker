// Errors raised while reading a day of time entries. The message names the line.
export class TimeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeParseError";
  }
}
