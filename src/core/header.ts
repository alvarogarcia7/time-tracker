// The day header: a date such as 11/11 or 11/11/2026, optionally with a heading marker and a tag:
//   11/11      #toggl 11/11      # 11/11      ## toggl 11/11
// Shared by the Markdown parser and the HTML converter, so both accept the same headers.
export const HEADER_RE = /^(?:#+\s*)?(?:(\w+)\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:\s.*)?$/;
